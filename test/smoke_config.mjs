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

import { parseTopicInput, MAX_FILE_BYTES } from '../src/config.js';
import { rawChunkSize } from '@axona/protocol/std/chunk.js';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) console.log(`  ok ${++n} - ${m}`);
  else { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

console.log('config — topic input, and why the limit is 10 MB\n');

// ── 1. names ───────────────────────────────────────────────────────
{
  const r = parseTopicInput('design-team', 'eagle');
  ok('a plain name becomes { name, region }', r.name === 'design-team' && r.region === 'eagle');
  ok('surrounding whitespace is trimmed', parseTopicInput('  spaced  ', 'eagle').name === 'spaced');
}

// ── 2. topic IDs ───────────────────────────────────────────────────
{
  const id = 'a'.repeat(66);
  const r = parseTopicInput(id, 'eagle');
  ok('66 hex chars is treated as a topic ID', r.id === id && r.name === undefined);
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
