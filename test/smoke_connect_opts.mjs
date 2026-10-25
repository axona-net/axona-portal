// =====================================================================
// smoke_connect_opts.mjs — every `ready:` option this app hands to connect()
// is a key the installed kernel actually reads.
//
// Why this exists: portal.js passed `ready: { timeoutSec: 45 }` from its first
// commit to 0.36.0. The kernel's ready() destructures `timeoutMs` and nothing
// else that sounds like a deadline, so the 45 was ignored, the portal waited
// the 10 s default, and connect() threw MESH_UNREACHABLE on a slow room. No
// error anywhere; the option just vanished (Vega 61f9de5a, 2026-10-24).
//
// The fence reads the kernel's ready() signature out of the installed module
// and the app's `ready:` literals out of the source, then checks the keys. A
// kernel that renames the option fails this before it fails a user.
//
// Run: node test/smoke_connect_opts.mjs
// =====================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// The kernel package exports no deep paths, so the installed source is read
// by its path under node_modules, the same way check_kernel_pin reads its
// package.json.
const KERNEL_PEER = join(root, 'node_modules', '@axona', 'protocol', 'src', 'dht', 'AxonaPeer.js');

let n = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  n++;
  if (cond) console.log(`  ✓ ${label}`);
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ── the kernel's side: which keys ready() destructures ────────────────
const peerSrc = readFileSync(KERNEL_PEER, 'utf8');
const sig = peerSrc.match(/async ready\(\{([^}]*)\}/);
ok('kernel ready() signature found in the installed @axona/protocol', !!sig);
const kernelKeys = new Set(
  (sig?.[1] ?? '').split(',').map((s) => s.trim().split('=')[0].trim()).filter(Boolean),
);
ok('kernel ready() reads timeoutMs', kernelKeys.has('timeoutMs'), [...kernelKeys].join(','));

// ── the app's side: every `ready: { … }` literal in src/ and scripts/ ─
const FILES = ['src/portal.js', 'scripts/live-transfer.mjs', 'scripts/live-app-interop.mjs'];
let sites = 0;
for (const f of FILES) {
  const text = readFileSync(join(root, f), 'utf8');
  for (const m of text.matchAll(/ready:\s*\{([^}]*)\}/g)) {
    sites++;
    const keys = m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean);
    const unknown = keys.filter((k) => !kernelKeys.has(k));
    ok(`${f}: ready keys {${keys.join(', ')}} are all read by the kernel`, unknown.length === 0,
       `unknown: ${unknown.join(', ')}`);
    ok(`${f}: ready sets a deadline the kernel reads (timeoutMs)`, keys.includes('timeoutMs'));
  }
}
ok('every connect() call site with a ready option was found (3)', sites === 3, `found ${sites}`);

console.log(`\n${fail === 0 ? '✓' : '✗'} smoke_connect_opts: ${n - fail}/${n} checks passed`);
process.exit(fail === 0 ? 0 : 1);
