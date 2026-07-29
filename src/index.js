#!/usr/bin/env node
// =====================================================================
// index.js — start the portal: config, peer, local server, browser.
//
//   npx axona-portal            # or: npm start
//   AXONA_PORT=7788 npm start   # if 7777 is taken
//   AXONA_BRIDGE=wss://…        # point at another bridge (e.g. testnet)
//   AXONA_NO_OPEN=1 npm start   # don't launch a browser
// =====================================================================

import { loadConfig, saveConfig, CONFIG_DIR } from './config.js';
import { Portal, KERNEL_VERSION } from './portal.js';
import { startServer } from './server.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Where a running portal advertises itself to the launcher. The launcher reads
// this so a SECOND double-click re-opens the existing window instead of trying
// to bind a port that is already taken — the difference between "the app is
// already running" and an EADDRINUSE stack trace in a Terminal window.
//
// It holds the session token, so it is 0600 and is removed on exit. Same trust
// domain as the browser tab that is already holding the token.
const RUNTIME_FILE = join(CONFIG_DIR, 'runtime.json');

const APP_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

function openBrowser(url) {
  if (process.env.AXONA_NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'explorer.exe' : 'xdg-open';
  try { spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* */ }
}

const cfg = loadConfig();
if (process.env.AXONA_BRIDGE) cfg.bridge = process.env.AXONA_BRIDGE;
if (process.env.AXONA_PORT)   cfg.port   = Number(process.env.AXONA_PORT);

console.log(`axona.portal ${APP_VERSION} · kernel ${KERNEL_VERSION}`);
console.log(`  bridge   ${cfg.bridge}`);
console.log(`  saving   ${cfg.saveDir}`);

const portal = new Portal(cfg, () => {});          // real sink installed by startServer

let started;
try {
  started = await startServer(portal, cfg);
} catch (e) {
  // A busy port is the single most likely startup failure — the portal is
  // already running, or something else took 7777. A double-clicked app must
  // say that in words; an EADDRINUSE stack trace in a Terminal window is not
  // an error message, it is a puzzle. (Found by running the launcher with a
  // stale port and no runtime.json.)
  if (e && e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${cfg.port} is already in use.\n`);
    console.error(`  If axona.portal is already running, use that window.`);
    console.error(`  Otherwise start this one on a different port:\n`);
    console.error(`      AXONA_PORT=7788 npm start\n`);
    console.error(`  To find what holds the port:  lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN\n`);
    process.exit(1);
  }
  throw e;
}
const { url } = started;
console.log(`\n  ${url}\n`);
try {
  writeFileSync(RUNTIME_FILE, JSON.stringify({ url, pid: process.pid, port: cfg.port }) + '\n',
    { mode: 0o600 });
} catch { /* advertising is a convenience; never block startup on it */ }
openBrowser(url);

try {
  await portal.start();
} catch (e) {
  // Failing to reach the bridge must be legible, not a stack trace. The UI is
  // already up and will show the same message.
  portal.status.connected = false;
  portal.status.error = e.message;
  portal.emit({ type: 'status', status: portal.status });
  console.error(`\n  could not connect: ${e.message}\n  the window is open; fix the network and restart.\n`);
}
saveConfig(cfg);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(1);                  // second ^C = impatience, honour it
    closing = true;
    console.log('\nleaving the mesh…');
    try { saveConfig(cfg); } catch { /* */ }
    try { unlinkSync(RUNTIME_FILE); } catch { /* already gone */ }
    await portal.stop().catch(() => {});
    process.exit(0);
  });
}
