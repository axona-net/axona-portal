// =====================================================================
// smoke_config.mjs — topic input parsing and the file-size ceiling.
//
// Two things worth pinning:
//   1. parseTopicInput accepts what a person types and REFUSES what would
//      silently become the wrong topic. A mistyped topic is a file sent to an
//      address nobody is listening on, with no error anywhere — exactly the
//      silent-failure class this codebase keeps getting bitten by.
//   2. MAX_FILE_BYTES stays under the protocol's replay-cache ceiling. The 10 MB
//      limit is not a preference; above ~10.4 MB a transfer cannot be
//      reassembled by anyone who subscribes after it was sent.
//
// Run: node test/smoke_config.mjs
// =====================================================================

import { parseTopicInput, MAX_FILE_BYTES, TOPIC_PREFIX, namespaced } from '../src/config.js';
import { rawChunkSize } from '@axona/protocol/std/chunk.js';
import { deriveTopicId } from '@axona/protocol';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) console.log(`  ok ${++n} - ${m}`);
  else { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('config — topic input, and why the limit is 10 MB\n');

// ── 1. names live under the portal. namespace ──────────────────────
// THE DEFECT THIS GUARDS (2026-07-28). Typing "axona.bot" derived exactly the
// address another app uses by that name — one plausible word away from
// publishing file chunks into someone's conversation. Nothing was broken:
// one flat namespace, both parties addressing it correctly. The fix has to be
// structural, so the prefix is asserted here rather than trusted.
{
  const r = parseTopicInput('design-team', 'eagle');
  ok('a plain name is namespaced', r.name === 'portal.design-team', r.name);
  ok('…and carries the region', r.region === 'eagle');
  ok('surrounding whitespace is trimmed first',
    parseTopicInput('  spaced  ', 'eagle').name === 'portal.spaced');

  // Idempotent: the UI shows the full name and people paste back what they see.
  ok('an already-namespaced name is not doubled',
    parseTopicInput('portal.design-team', 'eagle').name === 'portal.design-team');
  ok('namespaced() is idempotent', namespaced(namespaced('x')) === 'portal.x');
  ok('the prefix constant is what is applied', TOPIC_PREFIX === 'portal.');
}

// ── 1b. the namespace actually changes the ADDRESS ─────────────────
// A prefix that produced the same topic id would be decoration. This is the
// assertion that makes the collision structurally impossible.
{
  const collided  = await deriveTopicId({ region: 'eagle', name: 'axona.bot' });
  const namespacedId = await deriveTopicId(
    { region: 'eagle', name: parseTopicInput('axona.bot', 'eagle').name });
  ok('the namespaced topic is a DIFFERENT address', collided !== namespacedId,
    `${collided.slice(0, 12)}… vs ${namespacedId.slice(0, 12)}…`);
  console.log(`     bare "axona.bot"        -> ${collided.slice(0, 16)}…`);
  console.log(`     "portal.axona.bot"      -> ${namespacedId.slice(0, 16)}…`);
}

// ── 2. topic IDs ───────────────────────────────────────────────────
{
  const id = 'a'.repeat(66);
  const r = parseTopicInput(id, 'eagle');
  ok('66 hex chars is treated as a topic ID', r.id === id && r.name === undefined);
  // An id is already a resolved address; it cannot be namespaced, and typing 66
  // hex characters is a deliberate act, not a slip. This is the escape hatch.
  ok('…and is NOT namespaced', !String(r.id).startsWith(TOPIC_PREFIX));
  ok('an ID is lower-cased', parseTopicInput('A'.repeat(66), 'eagle').id === 'a'.repeat(66));
  ok('65 hex chars is REFUSED, not treated as a name', throws(() => parseTopicInput('a'.repeat(65), 'eagle')));
  ok('67 hex chars is REFUSED', throws(() => parseTopicInput('a'.repeat(67), 'eagle')));
  // The near-miss is the dangerous case: a truncated paste must not silently
  // become a topic literally NAMED "aaaa…", which would look fine and deliver
  // to a topic nobody else is on.
  ok('a 64-char hex paste is refused rather than silently named',
    throws(() => parseTopicInput('a'.repeat(64), 'eagle')));
}

// ── 3. junk ────────────────────────────────────────────────────────
{
  ok('empty is refused',        throws(() => parseTopicInput('', 'eagle')));
  ok('whitespace is refused',   throws(() => parseTopicInput('   ', 'eagle')));
  ok('undefined is refused',    throws(() => parseTopicInput(undefined, 'eagle')));
  ok('over-long is refused',    throws(() => parseTopicInput('x'.repeat(200), 'eagle')));
  ok('control chars refused',   throws(() => parseTopicInput('bad\u0007name', 'eagle')));
}

// ── 4. the size limit is the protocol's, not a guess ───────────────
{
  const CACHE = 1024;                       // kernel DEFAULT_REPLAY_CACHE_SIZE (O-1)
  const raw   = rawChunkSize();
  const msgs  = Math.ceil(MAX_FILE_BYTES / raw) + 1;   // +1 manifest
  console.log(`     ${MAX_FILE_BYTES} bytes / ${raw} B per chunk = ${msgs} messages (cache holds ${CACHE})`);
  ok('a max-size file fits the replay cache', msgs <= CACHE, `${msgs} > ${CACHE}`);
  ok('the limit is exactly 10 MB', MAX_FILE_BYTES === 10 * 1024 * 1024);
  // If the kernel ever shrinks the chunk size, this catches it before a user does.
  ok('there is real headroom (not scraping the ceiling)', msgs < CACHE * 0.98, `${msgs}/${CACHE}`);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} config: ${n} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
