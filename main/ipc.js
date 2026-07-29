// =====================================================================
// main/ipc.js — the ONLY surface between the renderer and everything real.
//
// This file is the whole trust boundary of the desktop app, so it is small on
// purpose and every handler is written as if the renderer were hostile. It is
// not hostile today — it is our own page, with no network access and no remote
// content. But "the client is trusted" is exactly the assumption that turns a
// rendering bug or an injected script into filesystem access, and the cost of
// not making that assumption is about twenty lines.
//
// Concretely, that means:
//   · the renderer NEVER supplies a directory — the save folder comes from
//     config, so there is no argument that could name an absolute path;
//   · open/reveal go through launch.js, which re-checks containment against the
//     save folder and refuses executables, rather than trusting a path that
//     came back from the page it originally sent it to;
//   · sizes are checked here as well as in the page, because a check in the
//     renderer is a courtesy to the user, not a control.
// =====================================================================

import { ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { MAX_FILE_BYTES, parseTopicInput, saveConfig } from '../src/config.js';
import { launch } from '../src/launch.js';
import { KERNEL_VERSION } from '../src/portal.js';

export function registerIpc({ portal, cfg, appVersion }) {
  /** Wrap a handler so a throw becomes a message instead of an unhandled
   *  rejection in the renderer's console — a failure the user cannot see is
   *  indistinguishable from the app ignoring them. */
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      try { return { ok: true, value: await fn(...args) }; }
      catch (e) { return { ok: false, error: e.message }; }
    });

  handle('portal:state', () => ({
    ...portal.state(),
    appVersion,
    kernel: KERNEL_VERSION,
    bridge: cfg.bridge,
  }));

  handle('portal:addTopic', async (value) => {
    const parsed = parseTopicInput(value, cfg.region);   // throws on junk, by design
    const topic = await portal.addTopic(parsed);
    saveConfig(cfg);
    return topic;
  });

  handle('portal:removeTopic', async (key) => {
    await portal.removeTopic(String(key ?? ''));
    saveConfig(cfg);
    return true;
  });

  /**
   * Send a file. The renderer hands over the BYTES it read from the drop, not a
   * path: a path would have to be resolved and containment-checked here, and
   * there is nothing to gain from letting the page name a file on disk that the
   * user did not drag in. 10 MB is small enough that copying it over IPC costs
   * nothing worth optimising.
   */
  handle('portal:send', async ({ topicKey, name, mime, buffer }) => {
    const bytes = new Uint8Array(buffer);
    if (bytes.length === 0)              throw new Error('That file is empty.');
    if (bytes.length > MAX_FILE_BYTES)   throw new Error(`${(bytes.length / 1048576).toFixed(1)} MB is over the 10 MB limit.`);
    return portal.send(String(topicKey ?? ''), { name: String(name ?? 'file'), bytes, mime: String(mime ?? 'application/octet-stream') });
  });

  // open / reveal: launch.js owns the rules. It resolves symlinks, requires the
  // result to be inside the save folder, and refuses to hand an executable to
  // the OS. Re-checked here rather than trusted because the path made a round
  // trip through the renderer.
  handle('portal:open',   (path) => {
    const r = launch('open', String(path ?? ''), cfg.saveDir);
    if (!r.ok) throw new Error(r.reason);
    return true;
  });
  handle('portal:reveal', (path) => {
    const r = launch('reveal', String(path ?? ''), cfg.saveDir);
    if (!r.ok) throw new Error(r.reason);
    return true;
  });

  // The save folder itself takes no argument at all — the one directory the
  // renderer may ask to see is the one it is not allowed to name.
  handle('portal:revealFolder', async () => {
    const err = await shell.openPath(join(cfg.saveDir, '.'));
    if (err) throw new Error(err);
    return true;
  });
}
