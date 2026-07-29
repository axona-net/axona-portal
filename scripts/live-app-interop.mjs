// =====================================================================
// live-app-interop.mjs — the APP exchanges a file with an AGENT, on production.
//
// ─── WHY THIS EXISTS, SPECIFICALLY ────────────────────────────────────
// scripts/live-transfer.mjs proved that src/transfer/ works, and
// axona-relay/scripts/live-file-interop.mjs proved that src/transfer/ and
// axona-relay/src/file-transfer.js agree. Both passed while the shipped
// desktop app could not exchange a file with an agent AT ALL — because
// src/portal.js, the class the app actually runs, never imported transfer/ and
// was still publishing raw chunks onto the shared topic.
//
// Every test called the engine directly. Nothing drove the app. So this one
// constructs a real Portal — the same object index.js builds — and makes it
// talk to the same code the MCP tools run. If it passes, a human dragging a
// file in and an agent asking for it are genuinely on the same network.
//
//   node scripts/live-app-interop.mjs
// =====================================================================

import { connect, resolveRegion, regionCenter } from '@axona/protocol';
import { Portal } from '../src/portal.js';
import { namespaced } from '../src/config.js';
import {
  sendFileBytes as agentSend, listPointers as agentList, hashBytes,
} from '../../axona-relay/src/file-transfer.js';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BRIDGE = process.env.BRIDGE_URL || 'wss://bridge.axona.net';
const REGION = 'eagle';
const SHARE  = namespaced(`appinterop.${Date.now()}`);

const t0 = Date.now();
const saveDir = await mkdtemp(join(tmpdir(), 'portal-interop-'));
console.log(`bridge ${BRIDGE} · shared topic ${SHARE}`);
console.log(`portal saves to ${saveDir}\n`);

// ── the human's side: a real Portal, exactly as index.js builds one ────
const events = [];
const portal = new Portal(
  { bridge: BRIDGE, region: REGION, saveDir, topics: [], port: 0 },
  (ev) => { events.push(ev); if (ev.type === 'log') console.log(`    portal: ${ev.text}`); },
);
console.log('portal: connecting…');
await portal.start();
await portal.addTopic({ name: SHARE, region: REGION });

// ── the agent's side: the code the MCP tools run ───────────────────────
const center = regionCenter(resolveRegion(REGION));
const a = await connect({ bridge: BRIDGE, location: { lat: center.lat, lng: center.lng },
                          author: true, ready: { timeoutSec: 45 } });
const agent = { peer: a.peer ?? a, author: a.author ?? null };
console.log('agent:  connected\n');

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms) => {
  for (let i = 0; i < ms / 500; i++) { if (await pred()) return true; await settle(500); }
  return false;
};

// ── DIRECTION 1 · human drags a file in, agent finds it ───────────────
console.log('── 1. portal sends, agent lists ──');
const outBytes = randomBytes(140 * 1024);
const outHash  = hashBytes(outBytes);
const sent = await portal.send(Portal.key({ name: SHARE, region: REGION }),
  { name: 'from-the-human.pdf', bytes: new Uint8Array(outBytes), mime: 'application/pdf' });
console.log(`  portal sent ${sent.name} · ${sent.chunks} chunks · sha ${sent.sha256?.slice(0, 12)}…`);

const listed = await agentList(agent.peer, { region: REGION, name: SHARE }, { seconds: 20 });
const foundByAgent = listed.find((f) => f.sha256 === outHash);
console.log(`  agent sees ${listed.length} file(s); the one we sent: ${!!foundByAgent}`);

// ── DIRECTION 2 · agent publishes, the portal auto-saves it ───────────
console.log('\n── 2. agent sends, portal receives and saves ──');
const inBytes = randomBytes(90 * 1024);
const inHash  = hashBytes(inBytes);
await agentSend(agent.peer, {
  bytes: new Uint8Array(inBytes), filename: 'from-the-agent.txt', mime: 'text/plain',
  shareTopic: { region: REGION, name: SHARE }, region: REGION, signWith: agent.author,
});
console.log(`  agent sent from-the-agent.txt · sha ${inHash.slice(0, 12)}…`);

const arrived = await until(async () =>
  (await readdir(saveDir)).some((n) => n.startsWith('from-the-agent')), 90_000);

let bytesMatch = false, savedName = null;
if (arrived) {
  savedName = (await readdir(saveDir)).find((n) => n.startsWith('from-the-agent'));
  const onDisk = new Uint8Array(await readFile(join(saveDir, savedName)));
  bytesMatch = Buffer.compare(Buffer.from(inBytes), Buffer.from(onDisk)) === 0;
  console.log(`  portal saved ${savedName} · bytes identical: ${bytesMatch}`);
} else {
  console.log('  portal never saved the file');
}

// The portal must NOT re-save its own outbound file. Before content addressing
// this was handled by a signer check alone; now the ledger backs it up.
const ownEcho = (await readdir(saveDir)).some((n) => n.startsWith('from-the-human'));
console.log(`  portal did not re-save its own send: ${!ownEcho}`);

// ── verdict ───────────────────────────────────────────────────────────
const pass = !!foundByAgent && arrived && bytesMatch && !ownEcho;
console.log('\n  app -> agent (agent found the pointer):  ' + !!foundByAgent);
console.log('  agent -> app (portal saved the bytes):   ' + (arrived && bytesMatch));
console.log('  no self-echo into the save folder:       ' + !ownEcho);
console.log(`\n${pass ? '✓ APP INTEROP PASS' : '✗ APP INTEROP FAIL'} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

try { await portal.stop(); } catch { /* */ }
try { await agent.peer.leave?.(); } catch { /* */ }
try { await rm(saveDir, { recursive: true, force: true }); } catch { /* */ }
process.exit(pass ? 0 : 1);
