// =====================================================================
// smoke_paths.mjs — the trust boundary, asserted.
//
// Every filename this app writes came off the network. These are the cases a
// hostile publisher would actually try, plus the ordinary ones that must keep
// working. If this file goes red, the portal can be made to write outside its
// save folder or to open something it should not — treat it as a stop-ship.
//
// Run: node test/smoke_paths.mjs
// =====================================================================

import { safeFilename, uniquePath, isInside, isLaunchable, MAX_NAME_LEN } from '../src/paths.js';
import { join, sep, isAbsolute } from 'node:path';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) console.log(`  ok ${++n} - ${m}`);
  else { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};

console.log('paths — a remote filename is hostile text, never a path\n');

// ── 1. traversal cannot escape, under either separator convention ──
{
  const attacks = [
    '../../../../etc/passwd',
    '..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts',
    '/etc/shadow',
    'C:\\Users\\me\\.ssh\\id_rsa',
    'subdir/../../escape.txt',
    '....//....//escape.txt',
  ];
  for (const a of attacks) {
    const s = safeFilename(a);
    ok(`"${a}" -> "${s}" has no separator`, !s.includes('/') && !s.includes('\\'), s);
    ok(`   …and is not absolute`, !isAbsolute(s), s);
  }
  // The decisive property: joined onto a folder it STAYS in that folder.
  const dir = sep === '\\' ? 'C:\\portal' : '/portal';
  for (const a of attacks) {
    ok(`join(dir, safe("${a.slice(0, 18)}…")) stays inside`, isInside(dir, join(dir, safeFilename(a))));
  }
}

// ── 2. control characters and terminal forgery ─────────────────────
{
  ok('NUL is stripped',      !safeFilename('re\u0000port.pdf').includes('\u0000'));
  ok('CR is stripped',       !safeFilename('a\rb.txt').includes('\r'));
  ok('ESC is stripped',      !safeFilename('a\u001b[31mred.txt').includes('\u001b'));
  ok('DEL is stripped',      !safeFilename('a\u007fb.txt').includes('\u007f'));
}

// ── 3. dotfiles, empties, reserved device names ────────────────────
{
  ok('no leading dot (dotfile)', !safeFilename('.bashrc').startsWith('.'), safeFilename('.bashrc'));
  ok('..  is not a filename',    !['.', '..'].includes(safeFilename('..')), safeFilename('..'));
  ok('empty name gets a fallback', safeFilename('') === 'file');
  ok('whitespace-only gets a fallback', safeFilename('   ') === 'file');
  ok('non-string gets a fallback', safeFilename(undefined) === 'file' && safeFilename(null) === 'file');
  ok('CON is escaped',  safeFilename('CON') !== 'CON', safeFilename('CON'));
  ok('con.txt is escaped', safeFilename('con.txt') !== 'con.txt', safeFilename('con.txt'));
  ok('LPT9 is escaped', safeFilename('LPT9') !== 'LPT9');
  ok('"contract.pdf" is NOT escaped (prefix, not device)', safeFilename('contract.pdf') === 'contract.pdf');
}

// ── 4. ordinary names survive intact ───────────────────────────────
{
  for (const good of ['report.pdf', 'Q3 numbers.xlsx', 'photo-2026.jpeg', 'notes_v2.md', 'ünïcodé.txt', '日本語.txt']) {
    ok(`"${good}" is preserved`, safeFilename(good) === good, safeFilename(good));
  }
}

// ── 5. length cap keeps the extension ──────────────────────────────
{
  const long = 'a'.repeat(400) + '.pdf';
  const s = safeFilename(long);
  ok('over-long name is truncated', s.length <= MAX_NAME_LEN, `len=${s.length}`);
  ok('…and keeps its extension',    s.endsWith('.pdf'), s);
}

// ── 6. uniquePath never clobbers ───────────────────────────────────
{
  const dir = sep === '\\' ? 'C:\\portal' : '/portal';
  const taken = new Set([join(dir, 'report.pdf'), join(dir, 'report (2).pdf')]);
  const p = uniquePath(dir, 'report.pdf', (x) => taken.has(x));
  ok('second collision becomes "report (3).pdf"', p === join(dir, 'report (3).pdf'), p);
  ok('a free name is used as-is',
    uniquePath(dir, 'fresh.txt', () => false) === join(dir, 'fresh.txt'));
  // A traversal attempt must be sanitised BEFORE the collision check.
  const evil = uniquePath(dir, '../../evil.sh', () => false);
  ok('uniquePath sanitises before joining', isInside(dir, evil), evil);
}

// ── 7. isInside is not fooled by a prefix match ────────────────────
{
  const dir = sep === '\\' ? 'C:\\portal' : '/portal';
  ok('a sibling with a shared prefix is OUTSIDE',
    !isInside(dir, dir + '-evil' + sep + 'x.txt'));
  ok('the folder itself is not "inside" itself', !isInside(dir, dir));
  ok('a real child is inside', isInside(dir, join(dir, 'a', 'b.txt')));
  ok('a traversal string is outside', !isInside(dir, join(dir, '..', 'x.txt')));
}

// ── 8. executables are never handed to the OS launcher ─────────────
{
  for (const bad of ['virus.exe', 'thing.app', 'x.sh', 'y.command', 'z.bat', 'p.ps1', 'q.jar', 'r.dmg', 'PAYLOAD.EXE']) {
    ok(`${bad} is NOT launchable`, !isLaunchable(bad));
  }
  for (const good of ['report.pdf', 'photo.png', 'notes.txt', 'sheet.xlsx', 'clip.mp4']) {
    ok(`${good} is launchable`, isLaunchable(good));
  }
  // The check must be on the FINAL extension, not any extension present.
  ok('report.pdf.exe is NOT launchable', !isLaunchable('report.pdf.exe'));
  ok('archive.exe.pdf IS launchable (final ext wins)', isLaunchable('archive.exe.pdf'));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} paths: ${n} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
