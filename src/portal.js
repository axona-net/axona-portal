// =====================================================================
// portal.js — the Axona side. One peer, N topics, files in and out.
//
// Shape of the thing:
//
//   connect()  one peer on the bridge, ephemeral node identity (I-ID)
//   watch()    one standing subscription per topic, listening for POINTERS
//   send()     bytes to their own hash topic, a pointer to the shared one
//
// ─── WHY POINTERS AND NOT CHUNKS ──────────────────────────────────────
// The first version published a file's chunks straight onto the shared topic
// and reassembled them there. That works for one file and quietly breaks on the
// second: a topic's replay cache holds ~1024 messages and a 10 MB file is 977 of
// them, so the next transfer EVICTS the previous one and a later subscriber can
// no longer reassemble it. Nothing errors; the file is simply not there.
//
// So a file's bytes now go to a topic derived from their own sha256 and only a
// few hundred bytes of pointer land on the shared topic. The shared topic
// becomes an index — thousands of entries before it is anywhere near full — and
// the hash is both the address and the integrity check.
//
// This is also the wire format the MCP file tools speak (axona-relay/src/
// file-transfer.js implements the same manifest v1 independently). An agent and
// a human portal can only exchange a file because BOTH sides go through
// transfer/; publishing chunks here would silently talk past the agent.
//
// Files are written as they complete. Nothing is auto-opened, ever — the user
// clicks, and launch.js decides whether that click is safe to honour.
// =====================================================================

import { connect, KERNEL_VERSION, resolveRegion, regionCenter, deriveTopicId } from '@axona/protocol';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { uniquePath } from './paths.js';
import { MAX_FILE_BYTES } from './config.js';
import { sendFile, watchPointers, fetchBytes } from './transfer/index.js';
import { loadReceived, saveReceived } from './received.js';

export { KERNEL_VERSION };

const now = () => Date.now();

export class Portal {
  /** @param {object} cfg  @param {(ev:object)=>void} emit  UI event sink */
  constructor(cfg, emit) {
    this.cfg   = cfg;
    this.emit  = emit;
    this.peer  = null;
    this.author = null;
    this.subs  = new Map();      // topicKey -> { handle, topic }
    this.files = [];             // newest-first log of transfers, both directions
    this.received = loadReceived();   // sha256 -> {name, at}; survives restarts
    this.fetching = new Set();        // sha256 currently in flight
    this.status = { connected: false, peers: 0, kernel: KERNEL_VERSION, bridge: cfg.bridge, error: null };
  }

  // ── lifecycle ──────────────────────────────────────────────────────
  async start() {
    const region = resolveRegion(this.cfg.region) ?? resolveRegion('eagle');
    const center = regionCenter(region);
    this.emit({ type: 'log', text: `connecting to ${this.cfg.bridge}…` });

    // author:true mints a FRESH author each run. Deliberate: a durable author id
    // is a persistent public handle, and this app has no feature that needs one
    // yet. Transport identity is always ephemeral and is not ours to choose.
    const res = await connect({
      bridge:   this.cfg.bridge,
      location: { lat: center.lat, lng: center.lng },
      author:   true,
      ready:    { timeoutSec: 45 },
    });
    this.peer   = res.peer ?? res;
    this.author = res.author ?? null;
    this.region = region;

    this.status.connected = true;
    this.status.error = null;
    this.emit({ type: 'log', text: `connected · kernel ${KERNEL_VERSION}` });

    this._health = setInterval(() => this._pollHealth(), 4000);
    this._pollHealth();

    await mkdir(this.cfg.saveDir, { recursive: true });
    for (const t of this.cfg.topics) await this._watch(t).catch(e =>
      this.emit({ type: 'log', text: `could not watch ${t.name}: ${e.message}`, level: 'warn' }));
    this.pushState();
  }

  async stop() {
    clearInterval(this._health);
    for (const [, s] of this.subs) { try { await s.handle?.stop?.(); } catch { /* */ } }
    this.subs.clear();
    try { await this.peer?.leave?.({ timeoutMs: 3000 }); } catch { /* */ }
  }

  _pollHealth() {
    try {
      const h = this.peer?.health?.();
      this.status.peers = h?.peers?.length ?? h?.synaptomeSize ?? 0;
      this.status.connected = true;
    } catch { this.status.connected = false; }
    this.emit({ type: 'status', status: this.status });
  }

  // ── topics ─────────────────────────────────────────────────────────
  /** Descriptor the kernel wants, from our stored shape. */
  _descriptor(t) { return t.id ? t.id : { region: t.region ?? this.cfg.region, name: t.name }; }
  static key(t)  { return t.id ? `id:${t.id}` : `n:${t.region}/${t.name}`; }

  async addTopic(parsed) {
    const topic = parsed.id
      ? { id: parsed.id, name: `${parsed.id.slice(0, 10)}…`, region: null, addedAt: now() }
      : { name: parsed.name, region: parsed.region, addedAt: now() };
    const key = Portal.key(topic);
    if (this.subs.has(key)) throw new Error('That topic is already in the list.');

    // Resolve the shareable id up front: it is what the user hands to whoever
    // they want to receive from, and failing here is far kinder than failing
    // silently at publish time.
    if (!topic.id) {
      topic.resolvedId = await deriveTopicId({ region: topic.region, name: topic.name });
    }
    await this._watch(topic);
    this.cfg.topics.push(topic);
    this.pushState();
    return topic;
  }

  async removeTopic(key) {
    const s = this.subs.get(key);
    if (s) { try { await s.handle?.stop?.(); } catch { /* */ } this.subs.delete(key); }
    this.cfg.topics = this.cfg.topics.filter(t => Portal.key(t) !== key);
    this.pushState();
  }

  /** One standing subscription per topic, listening for pointers. */
  async _watch(topic) {
    const key = Portal.key(topic);
    if (this.subs.has(key)) return;

    const handle = await watchPointers(this.peer, this._descriptor(topic), (pointer) => {
      // Our own announcements come back through the mesh. Fetching and saving a
      // file this machine just sent would put a duplicate in the folder.
      // `authorId` IS `signerPubkey` on the wire (identity/index.js:191).
      if (this.author && pointer.signer && pointer.signer === this.author.authorId) return;
      this._onPointer(topic, pointer).catch(e =>
        this.emit({ type: 'log', level: 'error', text: `${pointer.filename}: ${e.message}` }));
    }, { since: 'all' });

    this.subs.set(key, { handle, topic });
    this.emit({ type: 'log', text: `watching ${topic.name}` });
  }

  // ── receive ────────────────────────────────────────────────────────
  /**
   * A pointer arrived. Decide whether to fetch it, then fetch-verify-save.
   *
   * The portal auto-fetches because a human chose this topic and is watching
   * the window — that is the difference between this app and the MCP tools,
   * which are pull-only precisely because no human is watching there.
   *
   * Every refusal below happens BEFORE any bytes are requested. Declining to
   * start a 977-chunk download is the cheap place to say no; discovering the
   * problem after reassembly is not.
   */
  async _onPointer(topic, pointer) {
    const { sha256, filename, bytes } = pointer;

    if (this.received.has(sha256)) return;      // already on disk from an earlier run
    if (this.fetching.has(sha256)) return;      // two topics can announce one file
    if (bytes > MAX_FILE_BYTES) {
      this.emit({ type: 'log', level: 'warn',
        text: `ignored ${filename}: announced as ${(bytes / 1048576).toFixed(1)} MB, over the 10 MB limit` });
      return;
    }

    this.fetching.add(sha256);
    this.emit({ type: 'log', text: `fetching ${filename} (${(bytes / 1024).toFixed(0)} KB)…` });
    try {
      const file = await fetchBytes(this.peer, {
        sha256, region: topic.region ?? this.cfg.region,
        onProgress: ({ have, total }) => {
          if (total) this.emit({ type: 'progress', dir: 'in', topic: topic.name, id: sha256, have, total });
        },
      });
      // fetchBytes has already recomputed the hash and refused a mismatch, so
      // what lands here is the file that was named — verified by arithmetic,
      // not by trusting the sender, the pointer, or the network.
      await this._save(topic, file, pointer);
    } finally {
      this.fetching.delete(sha256);
    }
  }

  async _save(topic, file, pointer) {
    await mkdir(this.cfg.saveDir, { recursive: true });
    // The filename comes from the pointer, which came off a public topic: it is
    // hostile text until paths.js has reduced it to one harmless component.
    const path = uniquePath(this.cfg.saveDir, pointer.filename || file.filename, existsSync);
    // 0600: a file that arrived from the network is readable by this user only,
    // and never carries an execute bit no matter what the sender named it.
    await writeFile(path, file.bytes, { mode: 0o600 });

    this.received.set(file.sha256, { name: basename(path), at: now() });
    saveReceived(this.received);

    const rec = {
      dir: 'in', name: basename(path), path, size: file.bytes.length,
      topic: topic.name, at: now(), mime: file.mime ?? 'application/octet-stream',
      sha256: file.sha256,
    };
    this.files.unshift(rec);
    this.files = this.files.slice(0, 200);
    this.emit({ type: 'file', file: rec });
    this.pushState();
  }

  // ── send ───────────────────────────────────────────────────────────
  async send(key, { name, bytes, mime }) {
    const s = this.subs.get(key);
    if (!s) throw new Error('Pick a topic first.');
    if (bytes.length === 0) throw new Error('That file is empty.');
    if (bytes.length > MAX_FILE_BYTES) {
      throw new Error(`${(bytes.length / 1048576).toFixed(1)} MB is over the 10 MB limit.`);
    }

    const label = s.topic.name;
    this.emit({ type: 'log', text: `sending ${name} to ${label}…` });

    const r = await sendFile(this.peer, {
      bytes, filename: name, mime,
      shareTopic: this._descriptor(s.topic),
      region: s.topic.region ?? this.cfg.region,
      signWith: this.author,
      onProgress: ({ have, total }) => {
        if (total) this.emit({ type: 'progress', dir: 'out', topic: label, id: name, have, total });
      },
    });

    // Remember what we sent. Our own pointer comes back through the mesh and is
    // filtered by signer, but a SECOND portal signed-in as the same author (or a
    // re-send after a restart, when the author is fresh) would otherwise fetch
    // back a file this machine already has.
    this.received.set(r.sha256, { name, at: now() });
    saveReceived(this.received);

    const rec = {
      dir: 'out', name, size: bytes.length, topic: label, at: now(), mime,
      chunks: r.chunks, repaired: r.repaired, sha256: r.sha256,
    };
    this.files.unshift(rec);
    this.files = this.files.slice(0, 200);
    this.emit({ type: 'log',
      text: `sent ${name} — ${r.chunks} chunks${r.repaired ? `, ${r.repaired} repaired` : ''}` });
    this.emit({ type: 'file', file: rec });
    this.pushState();
    return rec;
  }

  // ── state for the UI ───────────────────────────────────────────────
  state() {
    return {
      status: this.status,
      saveDir: this.cfg.saveDir,
      maxBytes: MAX_FILE_BYTES,
      topics: this.cfg.topics.map(t => ({
        key: Portal.key(t), name: t.name, region: t.region,
        id: t.id ?? t.resolvedId ?? null, watching: this.subs.has(Portal.key(t)),
      })),
      files: this.files,
    };
  }

  pushState() { this.emit({ type: 'state', state: this.state() }); }
}
