// =====================================================================
// main/index.js — the Electron main process. Owns the peer, the disk, the app.
//
// ─── WHAT MOVING TO ELECTRON ACTUALLY BOUGHT ──────────────────────────
// The previous shape was a Node process serving a localhost HTTP server that a
// real browser connected to. That works, but the browser is a hostile
// neighbourhood: any page the user has open can POST to 127.0.0.1, so the app
// needed an Origin check, a per-run secret token in the URL, and a template
// substitution to get that token into the page. All three existed to defend a
// listening socket.
//
// Here there is no socket. The renderer reaches main only through IPC channels
// this file registers, so "another site could drive the portal" is not defended
// against — it is unrepresentable. server.js, the token, and the %%TOKEN%%
// substitution (which had already produced one silent bug) are deleted rather
// than ported.
//
// The renderer runs with sandbox:true, contextIsolation:true and no Node
// integration. It cannot read a file, open a socket, or require a module; it
// can call the handful of functions preload/index.cjs exposes and nothing else.
// =====================================================================

import { app, BrowserWindow, shell, dialog } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { cleanup } from 'node-datachannel';
import { loadConfig, saveConfig } from '../src/config.js';
import { Portal, KERNEL_VERSION } from '../src/portal.js';
import { registerIpc } from './ipc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Nothing in main may fail quietly. In a packaged build there is no terminal in
// front of the user, so an unhandled rejection would otherwise leave an app that
// launched, drew a window, and did nothing — which is exactly what a broken
// packaged build looked like the first time one was made.
process.on('uncaughtException',  (e) => console.error(`uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => console.error(`unhandled rejection: ${e?.stack ?? e}`));

// One portal per machine. A second copy would mint a second peer and race the
// first for the same save folder — two writers, one directory, duplicate files.
if (!app.requestSingleInstanceLock()) app.exit(0);

const cfg = loadConfig();
if (process.env.AXONA_BRIDGE) cfg.bridge = process.env.AXONA_BRIDGE;

let win = null;
let portal = null;

// Events emitted before the window exists (or while it is reloading) would
// otherwise be dropped — the peer starts connecting immediately and the first
// "connected" is exactly the one a user is waiting to see.
const pending = [];
let lastConnected = null;
const emit = (ev) => {
  // Running from source, the terminal is the only place the peer's state is
  // visible without opening DevTools — and "did it actually reach the bridge?"
  // is the first question anyone building this asks.
  if (!app.isPackaged) {
    if (ev.type === 'log')   console.log(`  ${ev.text}`);
    if (ev.type === 'status' && ev.status.connected !== lastConnected) {
      lastConnected = ev.status.connected;
      console.log(`  ${ev.status.connected ? `connected · ${ev.status.peers} peers` : `not connected${ev.status.error ? ` — ${ev.status.error}` : ''}`}`);
    }
  }
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('portal:event', ev);
  else { pending.push(ev); if (pending.length > 200) pending.shift(); }
};

function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 820, minWidth: 420, minHeight: 560,
    title: 'axona.portal',
    backgroundColor: '#12141a',
    show: false,
    webPreferences: {
      preload: join(HERE, '..', 'preload', 'index.cjs'),
      contextIsolation: true,     // renderer globals cannot reach preload's scope
      nodeIntegration: false,     // no require(), no process, no fs
      sandbox: true,              // OS-level sandbox on the renderer too
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // In a dev run, a renderer exception lands in a DevTools console nobody has
  // open and the window just sits there looking fine. Forward it to the
  // terminal, where whoever ran `npm start` is already looking.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
    });
    win.webContents.on('preload-error', (_e, path, err) =>
      console.error(`[preload] ${path}: ${err.message}`));
  }
  win.webContents.on('did-finish-load', () => {
    while (pending.length) win.webContents.send('portal:event', pending.shift());
    if (portal) win.webContents.send('portal:event', { type: 'state', state: portal.state() });
  });

  // A link in the UI must open in the user's browser, never navigate the app
  // window — a renderer that can be navigated somewhere else is a renderer that
  // can be replaced with someone else's page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.loadFile(join(ROOT, 'renderer', 'index.html'));
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  createWindow();

  portal = new Portal(cfg, emit);
  registerIpc({ portal, cfg, getWindow: () => win, appVersion: APP_VERSION });

  try {
    await portal.start();
  } catch (e) {
    // A bridge we cannot reach must be legible in the window, not a stack trace
    // in a console the user will never open. But it is ALSO logged
    // unconditionally, packaged or not: the packaged build once failed to
    // connect while printing nothing at all, because the only report went to a
    // window and the only log was behind an isPackaged check.
    portal.status.connected = false;
    portal.status.error = e.message;
    emit({ type: 'status', status: portal.status });
    console.error(`could not connect: ${e.stack ?? e.message}`);
  }
  saveConfig(cfg);

  // The unsigned-build explainer. Shown once, and only in a packaged build:
  // running from source is a deliberate act that needs no warning, and the
  // Gatekeeper friction it describes does not apply there.
  if (app.isPackaged && !cfg.seenFirstRun) {
    cfg.seenFirstRun = true;
    saveConfig(cfg);
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'About this build',
      message: 'axona.portal is not code-signed.',
      detail:
        'This copy carries no Developer ID, so macOS and Windows will warn that its ' +
        'publisher is unknown — that warning is accurate, and it is the same one you ' +
        'would get from any build you made yourself.\n\n' +
        'It also means the app cannot read ~/Documents, ~/Desktop or ~/Downloads ' +
        'unless you grant it. Received files are saved to a folder outside those, so ' +
        'nothing here needs that permission.\n\n' +
        'The source is at github.com/axona-net/axona-portal — building it yourself ' +
        'produces this same app with your own machine as the only thing you have to trust.',
      buttons: ['OK'],
    });
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/** Run a shutdown step, but never let it hold the app open. */
const bounded = (p, ms) =>
  Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);

let leaving = false;
app.on('before-quit', async (e) => {
  if (leaving) return;
  e.preventDefault();
  leaving = true;
  try { saveConfig(cfg); } catch { /* */ }

  // 1. Leave the mesh: hands our topic roles to a neighbour instead of making
  //    the mesh discover the departure by timeout.
  await bounded(portal?.stop?.(), 5000);

  // 2. Tear down WebRTC BEFORE Electron tears down the Node environment.
  //
  //    This step is not optional and its absence is not subtle. node-datachannel
  //    runs its own C++ worker threads that call back into JS through a
  //    ThreadSafeFunction. If the process exits with peer connections still
  //    open, one of those threads calls into a JS environment that is already
  //    being destroyed, the Napi call throws, and a C++ exception with no
  //    handler aborts the process — a SIGABRT crash report on every quit, in
  //    CleanupHandles, with the RTC threads still inside ~SctpTransport.
  //    Observed on macOS 26.5 with Electron 43 / node-datachannel 0.32.3.
  await bounded(cleanup(), 4000);

  app.exit(0);
});

console.log(`axona.portal ${APP_VERSION} · kernel ${KERNEL_VERSION}`);
