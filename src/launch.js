// =====================================================================
// launch.js — hand a file to the operating system, carefully.
//
// This is the one place the portal asks the OS to act on content that arrived
// from the network, so the rules are strict and live here rather than being
// re-derived at each call site:
//
//   1. the path must be INSIDE the save folder (no traversal, no absolute
//      paths supplied by the UI, no symlink escape — resolved, then checked)
//   2. the extension must not be executable (paths.isLaunchable)
//   3. arguments are passed as an ARGV ARRAY, never through a shell — a file
//      called `; rm -rf ~` is then just an odd filename, not a command
//
// `reveal` shows the file in the file manager instead of opening it. It is the
// escape hatch for anything rule 2 refuses: the user still gets to the file,
// but the decision to run it is taken in the OS, with the OS's warnings, not
// on a single click inside this app.
// =====================================================================

import { spawn } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { isInside, isLaunchable } from './paths.js';

function resolveReal(p) {
  // realpath BEFORE the containment check: a symlink inside the save folder
  // pointing at /etc/passwd would otherwise pass a naive string comparison.
  try { return realpathSync(p); } catch { return null; }
}

function platformCmd(action, target) {
  switch (process.platform) {
    case 'darwin':
      return action === 'reveal' ? ['open', ['-R', target]] : ['open', [target]];
    case 'win32':
      // `start` is a cmd builtin; explorer takes the path directly and does not
      // interpret it as a command line.
      return action === 'reveal' ? ['explorer.exe', [`/select,${target}`]] : ['explorer.exe', [target]];
    default:
      return action === 'reveal' ? ['xdg-open', [dirname(target)]] : ['xdg-open', [target]];
  }
}

/**
 * @param {'open'|'reveal'} action
 * @returns {{ ok: true } | { ok: false, reason: string, canReveal?: boolean }}
 */
export function launch(action, path, saveDir) {
  const real = resolveReal(path);
  if (!real || !existsSync(real)) return { ok: false, reason: 'That file is no longer on disk.' };

  const dirReal = resolveReal(saveDir) ?? saveDir;
  if (!isInside(dirReal, real)) {
    return { ok: false, reason: 'Refused: that path is outside the save folder.' };
  }
  if (action === 'open' && !isLaunchable(real)) {
    return {
      ok: false,
      canReveal: true,
      reason: 'This file type can execute code. The portal will not launch it — ' +
              'use Reveal and open it yourself if you trust the sender.',
    };
  }

  const [cmd, args] = platformCmd(action, real);
  try {
    // detached + ignored stdio: the viewer outliving the portal is correct, and
    // we never want a large app's output plumbed into our own pipes.
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.error(`[portal] ${cmd} failed: ${e.message}`));
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Could not launch: ${e.message}` };
  }
}
