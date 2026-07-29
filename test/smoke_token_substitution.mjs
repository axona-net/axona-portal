// =====================================================================
// smoke_token_substitution.mjs — the UI must actually receive its token.
//
// THE DEFECT THIS GUARDS (found while first running the app, 2026-07-28).
// index.html contained:
//
//     window.__TOKEN__ = "__TOKEN__";
//
// and the server did `String(body).replace('__TOKEN__', token)`. `replace` with
// a STRING pattern substitutes only the FIRST match — which was the identifier,
// not the value. The served page therefore declared a global named after the
// secret and left `window.__TOKEN__` undefined, so the socket connected with
// `t=undefined` and was correctly rejected.
//
// The symptom was almost nothing: the page rendered perfectly, the console was
// clean, and one status line read "portal stopped". Exactly the silent-failure
// class this project keeps paying for — so it gets a fence.
//
// Run: node test/smoke_token_substitution.mjs
// =====================================================================

import { readFileSync } from 'node:fs';

let n = 0, fail = 0;
const ok = (m, c, extra = '') => {
  if (c) console.log(`  ok ${++n} - ${m}`);
  else { console.log(`  ✗  ${m}${extra ? '  ' + extra : ''}`); fail++; }
};

const HTML   = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

console.log('token substitution — the page must end up holding the real token\n');

const PLACEHOLDER = '%%TOKEN%%';

// ── 1. the placeholder is distinct from any identifier in the page ──
{
  ok('index.html contains the placeholder', HTML.includes(PLACEHOLDER));
  ok('the placeholder is NOT a substring of the variable name',
    !'window.__TOKEN__'.includes(PLACEHOLDER));
  // The original bug in one assertion: the ASSIGNMENT ITSELF must carry the
  // placeholder as its value. (An earlier version of this test compared string
  // indices, which broke the moment a comment above the line also mentioned the
  // placeholder — the test was brittle, the code was fine.)
  ok('the assignment\'s VALUE is the placeholder',
    HTML.includes(`window.__TOKEN__ = "${PLACEHOLDER}"`),
    HTML.match(/window\.__TOKEN__ = "[^"]*"/)?.[0] ?? '(no assignment found)');
}

// ── 2. the server substitutes ALL occurrences ──────────────────────
{
  ok('the server uses replaceAll, not replace',
    /replaceAll\(\s*'%%TOKEN%%'/.test(SERVER));
  ok('no lingering single-shot replace of a token placeholder',
    !/\.replace\(\s*'(__TOKEN__|%%TOKEN%%)'/.test(SERVER));
}

// ── 3. the substitution actually works end to end ──────────────────
// Same operation the server performs, on the real file.
{
  const token = 'a'.repeat(48);
  const out = HTML.replaceAll(PLACEHOLDER, token);
  ok('no placeholder survives substitution', !out.includes(PLACEHOLDER));
  ok('the assignment now holds the token',
    out.includes(`window.__TOKEN__ = "${token}"`),
    out.match(/window\.__TOKEN__ = "[^"]*"/)?.[0] ?? '(no assignment found)');
  ok('the identifier itself was not clobbered', out.includes('window.__TOKEN__'));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} token substitution: ${n} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
