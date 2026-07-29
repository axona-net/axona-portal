// =====================================================================
// paths.js — every rule about turning a REMOTE filename into a local path.
//
// This module is small on purpose: it is the whole trust boundary of the app.
// A received file's `name` is chosen by whoever published it. They are not
// necessarily friendly, and an open topic is readable and writable by anyone
// who knows its id. So a name arriving off the network is treated as hostile
// text, never as a path.
//
// Three separate jobs, three separate functions, all pure and all tested:
//   safeFilename(name)          — hostile string  -> one harmless basename
//   uniquePath(dir, name)       — avoid clobbering a file already on disk
//   isInside(dir, target)       — containment check before we ever open()
//
// The rules, and why each one exists:
//   · basename only            "../../.ssh/authorized_keys" must not escape.
//   · no separators at all      including backslash — a Windows path handed to
//                               a POSIX host is one string, not a path, and
//                               would otherwise survive into the filename.
//   · strip control chars       a name containing \r or an ANSI escape can
//                               forge terminal output and misrepresent itself.
//   · no leading dot            a remote should not silently write a dotfile.
//   · reserved Windows names    CON, PRN, AUX, NUL, COM1-9, LPT1-9 are device
//                               names on Windows; writing to one is not a file.
//   · length cap                most filesystems cap a component at 255 bytes;
//                               the extension is preserved when truncating.
// =====================================================================

import { resolve, sep, join, extname, basename } from 'node:path';
import { existsSync } from 'node:fs';

export const MAX_NAME_LEN = 120;

// Windows device names, matched case-insensitively and without the extension.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Extensions the portal will NOT hand to the operating system's launcher.
// Saving them is fine — the file is inert on disk. Opening one means asking
// the OS to EXECUTE something a stranger sent you, which is not a thing this
// app should do on a single click. The UI offers "reveal in folder" instead,
// so the user can still get at the file deliberately, with the OS's own
// warnings in front of them.
export const NO_LAUNCH = new Set([
  '.app', '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif',
  '.sh', '.bash', '.zsh', '.command', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.jar', '.pkg', '.dmg', '.deb', '.rpm',
  '.run', '.bin', '.appimage', '.gadget', '.lnk', '.desktop', '.action',
  '.workflow', '.scpt', '.applescript', '.terminal',
]);

/**
 * Reduce an arbitrary remote string to a single safe filename component.
 * Never returns '', never returns something containing a path separator.
 */
export function safeFilename(name) {
  let s = typeof name === 'string' ? name : '';

  // Take the last component under BOTH separator conventions before anything
  // else, so a Windows-style path from a Windows sender collapses correctly on
  // a POSIX host (basename() alone would keep "..\\..\\evil" intact).
  s = s.split(/[\\/]/).pop() ?? '';

  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x1f\x7f]/g, '');            // control chars incl. NUL/CR/ESC
  s = s.replace(/[<>:"|?*]/g, '_');              // illegal on Windows, confusing elsewhere
  s = s.replace(/^[.\s]+/, '');                  // no dotfiles, no leading blanks
  s = s.replace(/[.\s]+$/, '');                  // Windows silently drops these
  s = s.trim();

  if (s === '') s = 'file';
  if (RESERVED.test(s.replace(/\.[^.]*$/, ''))) s = `_${s}`;

  if (s.length > MAX_NAME_LEN) {                 // truncate the STEM, keep the extension
    const ext = extname(s).slice(0, 16);
    s = s.slice(0, MAX_NAME_LEN - ext.length) + ext;
  }
  return s;
}

/**
 * A path inside `dir` that does not already exist: "report.pdf" becomes
 * "report (2).pdf" if taken. Two people can publish the same filename to the
 * same topic, and the second must not silently overwrite the first.
 */
export function uniquePath(dir, name, exists = existsSync) {
  const safe = safeFilename(name);
  let candidate = join(dir, safe);
  if (!exists(candidate)) return candidate;

  const ext  = extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let i = 2; i < 10000; i++) {
    candidate = join(dir, `${stem} (${i})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`paths: could not find a free name for "${safe}" in ${dir}`);
}

/**
 * True only if `target` resolves to something strictly inside `dir`.
 * Used before opening or revealing ANY path the UI names — the UI is local,
 * but it is still a separate process talking over a socket, and "the client
 * is trusted" is how directory traversal ships.
 */
export function isInside(dir, target) {
  const d = resolve(dir);
  const t = resolve(target);
  return t !== d && t.startsWith(d.endsWith(sep) ? d : d + sep);
}

/** True if the OS launcher must not be pointed at this file. */
export function isLaunchable(p) {
  return !NO_LAUNCH.has(extname(basename(p)).toLowerCase());
}
