// =====================================================================
// config.js — where the portal keeps its settings, and what a setting may be.
//
// Everything lives under ~/.axona-portal/ so the repo stays clean and a `git
// pull` never touches a user's topics:
//
//   ~/.axona-portal/config.json    topics, save folder, bridge, region
//   ~/Axona Portal/                default save folder (created on demand)
//
// NOTHING key-shaped is written here. The transport identity is minted fresh
// on every run and never persisted (INVARIANT I-ID: a stable node id is a
// correlator that ties every session to one machine and, through the bridge,
// one IP). The author identity is ephemeral for the same reason it is simple —
// see README. If a durable author is added later it belongs in its own file
// with its own permissions, not in this one.
// =====================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const CONFIG_DIR  = join(homedir(), '.axona-portal');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const DEFAULTS = Object.freeze({
  // Production bridge. The portal is a normal peer: the bridge is bootstrap and
  // signalling only, never the data path once the mesh forms.
  bridge:  'wss://bridge.axona.net',
  region:  'eagle',
  saveDir: join(homedir(), 'Axona Portal'),
  topics:  [],            // [{ id, name, region, addedAt }]
  port:    7777,
});

/**
 * Every topic this app addresses BY NAME lives under `portal.`.
 *
 * Why a namespace rather than care: a topic name is a global address, and the
 * obvious name for a thing is the name someone else already used. Typing
 * "axona.bot" here derived exactly the address a chat channel uses by that
 * name — one plausible word away from publishing a few hundred file chunks
 * into a conversation. Nothing warned, because nothing was wrong: it is one
 * flat namespace and both parties addressed it correctly.
 *
 * So the fix is structural, not advisory. `portal.axona.bot` cannot collide
 * with `axona.bot` no matter how obvious the name looked, and the prefix is
 * visible in the UI so the address you share is the address you see.
 *
 * A pasted 66-hex TOPIC ID is deliberately exempt: an id is already a resolved
 * address, it cannot be prefixed, and typing 66 hex characters is not a slip.
 * That remains the escape hatch for "I really do mean that exact topic".
 */
export const TOPIC_PREFIX = 'portal.';

/** 10 MB — the app's stated limit, and close to what the protocol allows. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// Why 10 MB and not "as big as you like": std/chunk splits a file into ~10752-byte
// messages and a topic's replay cache holds ~1024 of them (O-1). A transfer larger
// than the cache cannot be reassembled by anyone who subscribes AFTER it was sent —
// the mesh no longer holds every chunk. 10 MB is 977 messages, comfortably inside
// the ceiling; ~10.4 MB is the true wall. The limit is the protocol's, not a
// nervous guess, and refusing at 10 MB keeps every transfer replayable.

function ensureDir(d) { if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 }); }

export function loadConfig() {
  ensureDir(CONFIG_DIR);
  let stored = {};
  if (existsSync(CONFIG_FILE)) {
    try { stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); }
    catch (e) {
      // A corrupt config must not brick the app, but it must NOT be silently
      // replaced with defaults either — that loses the user's topic list with
      // no trace. Keep a copy and say so.
      const bak = `${CONFIG_FILE}.corrupt-${Date.now()}`;
      try { writeFileSync(bak, readFileSync(CONFIG_FILE)); } catch { /* best effort */ }
      console.error(`[portal] config.json is unreadable (${e.message}); kept a copy at ${bak} and started from defaults`);
      stored = {};
    }
  }
  const cfg = { ...DEFAULTS, ...stored };
  cfg.topics  = Array.isArray(cfg.topics) ? cfg.topics.filter(isValidTopic) : [];
  cfg.saveDir = resolve(String(cfg.saveDir || DEFAULTS.saveDir));
  cfg.port    = Number.isInteger(cfg.port) ? cfg.port : DEFAULTS.port;

  // Migrate topics saved before the namespace existed. This CHANGES the
  // address — `axona.bot` and `portal.axona.bot` are different topics — so it
  // is announced, never done quietly. Anyone you were sharing with needs the
  // new id, and being told beats discovering it through silence.
  // Topics held as a bare 66-hex id are left exactly as they are: an id is an
  // address that was chosen deliberately and is not ours to rewrite.
  const moved = [];
  for (const t of cfg.topics) {
    if (t.id || typeof t.name !== 'string') continue;
    const next = namespaced(t.name);
    if (next !== t.name) { moved.push(`${t.name} -> ${next}`); t.name = next; delete t.resolvedId; }
  }
  if (moved.length) {
    console.warn(`[portal] topics moved under the "${TOPIC_PREFIX}" namespace: ${moved.join(', ')}`);
    console.warn(`[portal] these are DIFFERENT topics — re-share the new ID with anyone sending to you.`);
  }
  return cfg;
}

export function saveConfig(cfg) {
  ensureDir(CONFIG_DIR);
  const out = {
    bridge: cfg.bridge, region: cfg.region, saveDir: cfg.saveDir,
    port: cfg.port, topics: cfg.topics,
  };
  writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
}

function isValidTopic(t) {
  return t && typeof t === 'object' && typeof t.name === 'string' && t.name.length > 0;
}

/**
 * Accept what a person would actually type. Two forms are legitimate:
 *   · a NAME       "design-team"  -> an open topic in the portal's region
 *   · a TOPIC ID   66 hex chars   -> the shareable read handle for a topic
 *                                    someone else derived; region is baked in
 * Returns { name, region } for a name, or { id } for an id. Throws on junk,
 * because a silently-mangled topic is a file sent into the void.
 */
export function parseTopicInput(raw, region) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('Enter a topic name or a 66-character topic ID.');

  if (/^[0-9a-fA-F]{66}$/.test(s)) return { id: s.toLowerCase() };
  if (/^[0-9a-fA-F]{40,}$/.test(s)) {
    throw new Error(`That looks like a topic ID but is ${s.length} hex characters — a topic ID is exactly 66.`);
  }
  if (s.length > 96) throw new Error('Topic names are limited to 96 characters.');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error('Topic names cannot contain control characters.');
  return { name: namespaced(s), region };
}

/**
 * Put a name under the portal namespace, idempotently. Typing the prefix
 * yourself must not produce `portal.portal.foo` — people paste back what the
 * UI shows them, and the UI shows the full name.
 */
export function namespaced(name) {
  const s = String(name ?? '').trim();
  return s.startsWith(TOPIC_PREFIX) ? s : TOPIC_PREFIX + s;
}
