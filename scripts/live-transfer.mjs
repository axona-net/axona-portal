// live end-to-end proof of content-addressed transfer over PRODUCTION.
//
// Two INDEPENDENT peers. A sends; B — which has never seen the bytes and shares
// no state with A — reads the pointer off the shared topic and fetches by hash.
// If this passes, the property holds on the real network, not just in unit
// tests where both sides are the same process.
import { connect, resolveRegion, regionCenter } from '@axona/protocol';
import { sendFile, fetchBytes, watchPointers, hashBytes } from './src/transfer/index.js';
import { randomBytes } from 'node:crypto';

const BRIDGE = process.env.BRIDGE_URL || 'wss://bridge.axona.net';
const REGION = 'eagle';
const SHARE  = { region: REGION, name: `portal.livetest.${Date.now()}` };

const center = regionCenter(resolveRegion(REGION));
const dial = async (label) => {
  const r = await connect({ bridge: BRIDGE, location: { lat: center.lat, lng: center.lng },
                            author: true, ready: { timeoutSec: 45 } });
  console.log(`  ${label} connected`);
  return { peer: r.peer ?? r, author: r.author ?? null };
};

const t0 = Date.now();
console.log(`bridge ${BRIDGE} · share topic ${SHARE.name}\n`);

const A = await dial('A (sender)  ');
const B = await dial('B (receiver)');

// A distinctive payload, big enough to be genuinely multi-chunk.
const payload = randomBytes(300 * 1024);
const expect  = hashBytes(payload);
console.log(`\npayload ${payload.length} bytes · sha256 ${expect.slice(0, 16)}…`);

// B watches for pointers BEFORE A sends — the realistic ordering.
const seen = [];
await watchPointers(B.peer, SHARE, (p) => { seen.push(p); console.log(`  B saw pointer: ${p.filename} ${p.bytes}B ${p.sha256.slice(0,12)}…`); });
await new Promise(r => setTimeout(r, 3000));

console.log('\nA: sending…');
const sent = await sendFile(A.peer, {
  bytes: payload, filename: 'live-test.bin', mime: 'application/octet-stream',
  shareTopic: SHARE, region: REGION, signWith: A.author,
});
console.log(`  chunks=${sent.chunks} repaired=${sent.repaired} fileTopic=${sent.fileTopic.name.slice(0,24)}…`);

// wait for the pointer to reach B
for (let i = 0; i < 30 && seen.length === 0; i++) await new Promise(r => setTimeout(r, 1000));

if (!seen.length) { console.log('\n✗ B never saw the pointer'); process.exit(1); }

console.log('\nB: fetching by hash (never told the topic, derives it from the hash)…');
const got = await fetchBytes(B.peer, { sha256: seen[0].sha256, region: REGION, timeoutMs: 90_000 });

const same = Buffer.compare(Buffer.from(payload), Buffer.from(got.bytes)) === 0;
console.log(`\n  bytes ${got.bytes.length} · sha256 ${hashBytes(got.bytes).slice(0,16)}…`);
console.log(`  identical to what A sent: ${same}`);
console.log(`  filename preserved: ${got.filename}`);

// the refusal path must actually refuse
let refused = false;
try {
  await fetchBytes(B.peer, { sha256: 'f'.repeat(64), region: REGION, timeoutMs: 4000 });
} catch (e) { refused = /timed out|does not match/.test(e.message); }
console.log(`  a hash nobody published does not resolve: ${refused}`);

console.log(`\n${same && refused ? '✓ PASS' : '✗ FAIL'} · ${((Date.now()-t0)/1000).toFixed(1)}s`);
try { await A.peer.leave?.(); await B.peer.leave?.(); } catch {}
process.exit(same && refused ? 0 : 1);
