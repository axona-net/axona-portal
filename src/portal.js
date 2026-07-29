// =====================================================================
// portal.js — the Axona side. One peer, N topics, files in and out.
//
// Shape of the thing:
//
//   connect()  one peer on the bridge, ephemeral node identity (I-ID)
//   watch()    one persistent subscription per topic, each with its own
//              reassembler, so a topic is a STREAM of files over time
//   send()     chunk + publish + verify, via @axona/protocol/std/chunk
//
// Why a persistent reassembler per topic rather than receiveChunkedBytes():
// that helper is one-shot — it subscribes, waits for ONE file, and resolves or
// times out. The portal is a standing inbox: it must catch every file that ever
// arrives on a watched topic, including several in flight at once. createReassembler
// is built for exactly that (it keys by fileId and fires once per completed file),
// so the portal holds one live subscription per topic and lets the reassembler
// demultiplex.
//
// Files are written as they complete. Nothing is auto-opened, ever — the user
// clicks, and launch.js decides whether that click is safe to honour.
// =====================================================================

import { connect, KERNEL_VERSION, resolveRegion, regionCenter, deriveTopicId } from '@axona/protocol';
import { createReassembler, publishChunkedBytes } from '@axona/protocol/std/chunk.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { uniquePath } from './paths.js';
import { MAX_FILE_BYTES } from './config.js';

export { KERNEL_VERSION };

const now = () => Date.now();

export class Portal {
  /** @param {object} cfg  @param {(ev:object)=>void} emit  UI event sink */
  constructor(cfg, emit) {
    this.cfg   = cfg;
    this.emit  = emit;
    this.peer  = null;
    this.author = null;
    this.subs  = new Map();      // topicKey -> { handle, reassembler, topic }
    this.files = [];             // newest-first log of transfers, both directions
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

  /** One standing subscription + one multi-file reassembler for this topic. */
  async _watch(topic) {
    const key = Portal.key(topic);
    if (this.subs.has(key)) return;
    const descriptor = this._descriptor(topic);
    const label = topic.name;

    const reassembler = createReassembler(
      (file) => { this._onFile(topic, file).catch(e =>
        this.emit({ type: 'log', text: `save failed: ${e.message}`, level: 'error' })); },
      { onProgress: ({ id, have, total }) => {
          if (total) this.emit({ type: 'progress', dir: 'in', topic: label, id, have, total });
        } },
    );

    const handle = await this.peer.sub(descriptor, (env) => {
      if (!env || env.deleted) return;
      // Our own publishes come back through the mesh. Reassembling and re-saving
      // a file this machine just sent would put a duplicate in the folder.
      // `authorId` IS `signerPubkey` on the wire (identity/index.js:191).
      if (this.author && env.signerPubkey && env.signerPubkey === this.author.authorId) return;
      reassembler.accept(env.message);
    }, { since: 'all' });

    this.subs.set(key, { handle, reassembler, topic });
    this.emit({ type: 'log', text: `watching ${label}` });
  }

  // ── receive ────────────────────────────────────────────────────────
  async _onFile(topic, file) {
    if (file.bytes.length > MAX_FILE_BYTES) {
      this.emit({ type: 'log', level: 'warn',
        text: `dropped ${file.name}: ${(file.bytes.length / 1048576).toFixed(1)} MB exceeds the 10 MB limit` });
      return;
    }
    await mkdir(this.cfg.saveDir, { recursive: true });
    const path = uniquePath(this.cfg.saveDir, file.name, existsSync);
    // 0600: a file that arrived from the network is readable by this user only,
    // and never carries an execute bit no matter what the sender named it.
    await writeFile(path, file.bytes, { mode: 0o600 });

    const rec = {
      dir: 'in', name: basename(path), path, size: file.bytes.length,
      topic: topic.name, at: now(), mime: file.mime ?? 'application/octet-stream',
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

    const r = await publishChunkedBytes(this.peer, bytes, {
      topic: this._descriptor(s.topic),
      signWith: this.author,
      name, mime,
    });

    const rec = {
      dir: 'out', name, size: bytes.length, topic: label, at: now(), mime,
      chunks: r.n, repaired: r.repaired,
    };
    this.files.unshift(rec);
    this.files = this.files.slice(0, 200);
    this.emit({ type: 'log',
      text: `sent ${name} — ${r.n} chunks${r.repaired ? `, ${r.repaired} repaired` : ''}` });
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
