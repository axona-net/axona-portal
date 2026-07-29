#!/usr/bin/env node
// =====================================================================
// index.js — start the portal: config, peer, local server, browser.
//
//   npx axona-portal            # or: npm start
//   AXONA_PORT=7788 npm start   # if 7777 is taken
//   AXONA_BRIDGE=wss://…        # point at another bridge (e.g. testnet)
//   AXONA_NO_OPEN=1 npm start   # don't launch a browser
// =====================================================================

import { loadConfig, saveConfig } from './config.js';
import { Portal, KERNEL_VERSION } from './portal.js';
import { startServer } from './server.js';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const { url } = await startServer(portal, cfg);
console.log(`\n  ${url}\n`);
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
    await portal.stop().catch(() => {});
    process.exit(0);
  });
}
