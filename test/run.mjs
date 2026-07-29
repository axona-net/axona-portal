// =====================================================================
// run.mjs — run every fence, and say how many ran.
//
// Replaces an `&&` chain. The chain was fine at catching a failure and useless
// at proving a full pass: it stops at the first non-zero exit, so "no output
// after test 2" and "tests 3-5 do not exist" look identical. The kernel has the
// same problem at a larger scale and it is a named blocker in the architecture
// scorecard; there is no reason to reproduce it here.
//
// So: the manifest is explicit, every file runs even if an earlier one fails,
// and the summary states the count. A suite that cannot report its own
// completeness cannot gate anything.
//
// Run: npm test
// =====================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Every fence in this repo. Adding a test file means adding it here — the
 *  missing-file check below turns a typo into a failure instead of a silent
 *  skip, which is the failure mode that lets a suite quietly shrink. */
const FENCES = [
  'check_kernel_pin.mjs',      // declared pin == installed kernel
  'smoke_paths.mjs',           // the trust boundary: hostile filename -> local path
  'smoke_config.mjs',          // topic parsing, the portal. namespace, size ceiling
  'smoke_manifest.mjs',        // content addressing + pointer validation
  'smoke_token_substitution.mjs',
];

let ran = 0, failed = 0;
const missing = FENCES.filter((f) => !existsSync(join(here, f)));
if (missing.length) {
  console.error(`✗ test manifest lists ${missing.length} file(s) that do not exist: ${missing.join(', ')}`);
  process.exit(1);
}

for (const f of FENCES) {
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  ran++;
  if (r.status !== 0) failed++;
  console.log('');
}

console.log('─'.repeat(60));
console.log(`${failed === 0 ? '✓' : '✗'} ${ran}/${FENCES.length} fences ran · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
