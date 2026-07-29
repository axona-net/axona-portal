// =====================================================================
// check_kernel_pin.mjs — declared == installed.
//
// This exists because npm has told us "success, 0 vulnerabilities" while
// re-resolving NOTHING, four separate times across this project's repos: the
// manifest said one kernel version and node_modules held another, and the
// mismatch shipped. The manifest is a wish; node_modules is the fact.
//
// Run: node test/check_kernel_pin.mjs
// =====================================================================

import { readFileSync } from 'node:fs';
import { KERNEL_VERSION } from '@axona/protocol';

const pkg      = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const declared = pkg.dependencies['@axona/protocol'];
const tag      = declared.match(/#v?(\d+\.\d+\.\d+)/)?.[1];

if (!tag) {
  console.error(`✗ kernel pin "${declared}" is not a #vX.Y.Z tag — pin an exact tag, not a branch or range.`);
  process.exit(1);
}
if (tag !== KERNEL_VERSION) {
  console.error(`✗ kernel pin MISMATCH: package.json declares v${tag}, node_modules has ${KERNEL_VERSION}`);
  console.error(`  Fix: rm -rf node_modules/@axona/protocol && npm install ${declared}`);
  console.error(`  (plain \`npm install\` after editing the pin often re-resolves nothing.)`);
  process.exit(1);
}
console.log(`check_kernel_pin: declared = installed = ${KERNEL_VERSION} ✓`);
