// =====================================================================
// smoke_ipc_surface.mjs — the main↔renderer boundary cannot drift.
//
// Two failure modes this catches, both of which are SILENT at runtime:
//
//  A. A CHANNEL MISMATCH. ipcRenderer.invoke on a channel main never
//     registered does not throw anywhere visible — it returns a promise that
//     never settles. The button simply does nothing, forever, and there is no
//     error in either console. Renaming a channel on one side only is a
//     one-character way to produce that, so the two lists are compared here.
//
//  B. A SECURITY REGRESSION. contextIsolation, nodeIntegration and sandbox are
//     three booleans that decide whether the renderer can reach the filesystem.
//     Turning one off to debug something and forgetting is easy, produces no
//     symptom at all, and hands a rendering bug the run of the machine. They
//     are asserted literally.
//
// It also refuses to let the localhost server come back. The whole reason
// Electron was worth the packaging cost is that there is no listening socket;
// re-adding one silently would give back the attack surface while keeping the
// comments that claim it is gone.
//
// Run: node test/smoke_ipc_surface.mjs
// =====================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) console.log(`  ok ${++n} - ${m}`);
  else { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};

console.log('ipc surface — the boundary between the page and the machine\n');

const mainIpc  = read('main/ipc.js');
const mainIdx  = read('main/index.js');
const preload  = read('preload/index.cjs');
const rendJs   = read('renderer/app.js');
const rendHtml = read('renderer/index.html');

// ── A. the two sides agree on the channel list ───────────────────────
{
  const registered = [...mainIpc.matchAll(/handle\(\s*'([^']+)'/g)].map((m) => m[1]).sort();
  const invoked    = [...preload.matchAll(/call\(\s*'([^']+)'/g)].map((m) => m[1]).sort();

  ok('main registers at least one channel', registered.length > 0);
  ok('preload invokes at least one channel', invoked.length > 0);

  const unregistered = invoked.filter((c) => !registered.includes(c));
  const unused       = registered.filter((c) => !invoked.includes(c));
  // An invoke with no handler hangs forever with no error anywhere — the worst
  // shape a bug can take, because it looks exactly like a UI that ignores you.
  ok('every channel the page calls has a handler', unregistered.length === 0, unregistered.join(', '));
  ok('every registered handler is reachable',      unused.length === 0, unused.join(', '));

  // The event channel is one-way (main -> renderer) so it is not in either list.
  ok('main pushes events on portal:event',   mainIdx.includes("'portal:event'"));
  ok('preload listens on portal:event',      preload.includes("'portal:event'"));
}

// ── B. the renderer stays powerless ──────────────────────────────────
{
  const wp = mainIdx.slice(mainIdx.indexOf('webPreferences'), mainIdx.indexOf('win.once'));
  ok('contextIsolation is on',  /contextIsolation:\s*true/.test(wp));
  ok('nodeIntegration is off',  /nodeIntegration:\s*false/.test(wp));
  ok('sandbox is on',           /sandbox:\s*true/.test(wp));
  ok('a preload is set',        /preload:/.test(wp));

  // contextBridge is the only sanctioned way across. Assigning to window
  // directly, or exposing ipcRenderer itself, would hand the page every channel
  // in the app rather than the seven it is meant to have.
  ok('preload goes through contextBridge', preload.includes('contextBridge.exposeInMainWorld'));
  ok('preload does not expose ipcRenderer wholesale',
    !/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer/.test(preload));

  ok('the renderer never requires anything', !/\brequire\s*\(/.test(rendJs));
  ok('the renderer touches no Node globals', !/\bprocess\.|__dirname|node:/.test(rendJs));
}

// ── C. the socket and the token stay dead ────────────────────────────
{
  const serverish = /createServer|WebSocketServer|\.listen\(/;
  ok('main starts no HTTP server',   !serverish.test(mainIdx) && !serverish.test(mainIpc));
  ok('the renderer opens no socket', !/new WebSocket|fetch\(/.test(rendJs));
  ok('no token survives in the page', !rendHtml.includes('TOKEN') && !rendJs.includes('TOKEN'));
  ok('no absolute /ui/ asset paths',  !rendHtml.includes('/ui/'));
}

// ── D. the save folder is never named by the renderer ────────────────
{
  // Every path the page can send is re-checked against cfg.saveDir by launch.js.
  // If a handler ever took a directory FROM the page, that check would be
  // comparing a value against itself.
  ok('open/reveal are checked by launch.js', /launch\('open'/.test(mainIpc) && /launch\('reveal'/.test(mainIpc));
  ok('the save folder comes from config',    /cfg\.saveDir/.test(mainIpc));
  ok('no handler accepts a directory argument', !/saveDir\s*[:=]\s*(String\()?\s*(dir|path|arg)/.test(mainIpc));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ipc surface: ${n} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
