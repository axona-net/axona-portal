// =====================================================================
// smoke_manifest.mjs — the pointer format, and the addressing property.
//
// Two things are load-bearing and neither is obvious from reading the code:
//
//   1. The file topic derives from CONTENT. Same bytes, same address —
//      that is what gives dedup and what lets a receiver verify without
//      trusting anyone. If this ever stops holding, every guarantee built on
//      "the hash is the address" quietly becomes a hope.
//   2. readPointer REFUSES junk. A shared topic is public; other apps' std
//      messages and outright garbage will land on it. A validator that
//      half-accepts is worse than none, because the caller then trusts fields
//      that were never checked.
//
// Run: node test/smoke_manifest.mjs
// =====================================================================

import { hashBytes, fileTopicName, makePointer, readPointer, MANIFEST_V, ENCODINGS } from '../src/transfer/manifest.js';
import { TOPIC_PREFIX, parseTopicInput } from '../src/config.js';
import { deriveTopicId } from '@axona/protocol';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) console.log(`  ok ${++n} - ${m}`);
  else { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const bytes = (s) => new TextEncoder().encode(s);

console.log('manifest — content addressing and pointer validation\n');

// ── 1. the address IS the content ──────────────────────────────────
{
  const a = hashBytes(bytes('hello world'));
  const b = hashBytes(bytes('hello world'));
  const c = hashBytes(bytes('hello world!'));
  ok('same bytes → same hash', a === b);
  ok('one byte different → different hash', a !== c);
  ok('hash is 64 lowercase hex', /^[0-9a-f]{64}$/.test(a), a);

  // The property everything rests on: identical files land on ONE topic.
  const ta = await deriveTopicId({ region: 'eagle', name: fileTopicName(a) });
  const tb = await deriveTopicId({ region: 'eagle', name: fileTopicName(b) });
  const tc = await deriveTopicId({ region: 'eagle', name: fileTopicName(c) });
  ok('identical content → identical topic (dedup)', ta === tb);
  ok('different content → different topic', ta !== tc);
}

// ── 2. file topics stay inside the portal namespace ────────────────
// The collision that created TOPIC_PREFIX applies here too, and a bare 64-hex
// name would additionally be read as a topic ID rather than a name.
{
  const h = hashBytes(bytes('x'));
  const nm = fileTopicName(h);
  ok('file topic is namespaced', nm.startsWith(TOPIC_PREFIX), nm);
  ok('…and is not mistaken for a 66-hex topic ID',
    parseTopicInput(nm, 'eagle').name === nm);
  ok('a non-hash is refused', throws(() => fileTopicName('nope')));
  ok('an UPPERCASE hash is refused (one canonical form only)',
    throws(() => fileTopicName(h.toUpperCase())));
}

// ── 3. pointers are small, complete, and versioned ─────────────────
{
  const h = hashBytes(bytes('abc'));
  const p = makePointer({ sha256: h, filename: 'notes.txt', bytes: 3, mime: 'text/plain' });
  ok('carries a version', p.v === MANIFEST_V);
  ok('carries kind=file', p.kind === 'file');
  ok('defaults encoding to raw', p.encoding === 'raw');
  ok('round-trips through JSON', JSON.stringify(readPointer(JSON.parse(JSON.stringify(p)))) === JSON.stringify(p));
  // Small enough that a shared topic holds thousands, which is the entire point.
  ok('a pointer is under 512 bytes', JSON.stringify(p).length < 512, `${JSON.stringify(p).length}B`);
  ok('bad sha256 refused',  throws(() => makePointer({ sha256: 'zz', filename: 'a', bytes: 1 })));
  ok('bad size refused',    throws(() => makePointer({ sha256: h, filename: 'a', bytes: -1 })));
  ok('unknown encoding refused', throws(() => makePointer({ sha256: h, filename: 'a', bytes: 1, encoding: 'zip' })));
  ok('zip is NOT yet a valid encoding', !ENCODINGS.has('zip'));
}

// ── 4. readPointer refuses everything that is not a pointer ────────
// Each of these WILL arrive on a public shared topic.
{
  const h = ovalid();
  function ovalid() { return hashBytes(bytes('q')); }
  const good = makePointer({ sha256: h, filename: 'a', bytes: 1 });

  ok('accepts a good pointer', readPointer(good) !== null);
  ok('rejects null',            readPointer(null) === null);
  ok('rejects a string',        readPointer('file') === null);
  ok('rejects a std/message',   readPointer({ v: 1, text: 'hi', handle: 'someone' }) === null);
  ok('rejects a future version',readPointer({ ...good, v: 99 }) === null);
  ok('rejects wrong kind',      readPointer({ ...good, kind: 'chat' }) === null);
  ok('rejects a bad hash',      readPointer({ ...good, sha256: 'nope' }) === null);
  ok('rejects a non-integer size', readPointer({ ...good, bytes: 1.5 }) === null);
  ok('rejects an unknown encoding', readPointer({ ...good, encoding: 'zip' }) === null);
  // A hostile filename must survive validation as DATA — sanitising is
  // paths.js's job at write time, not the validator's. What must not happen is
  // the validator passing through an object shape nobody checked.
  const nasty = readPointer({ ...good, filename: '../../etc/passwd' });
  ok('a hostile filename is accepted as data (paths.js sanitises at write)',
    nasty !== null && typeof nasty.filename === 'string');
  ok('…and no extra fields ride along', Object.keys(nasty).sort().join(',') === 'bytes,encoding,filename,kind,mime,sha256,v');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} manifest: ${n} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
