/* =============================================================================
   Bump the ?v= cache stamp on every css and js reference, on every page, to
   the same number.

   GitHub Pages serves assets with max-age=600. Editing style.css without
   bumping the stamp means up to ten minutes of visitors, including you,
   getting the old file: the change looks like it never deployed. Doing it by
   hand across nine pages drifted once already, which is what tools/audit.mjs
   now checks for.

   node tools/stamp.mjs        bump every page to (highest found + 1)
   node tools/stamp.mjs 21     set every page to exactly 21
   ========================================================================== */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
  'index.html', 'brief.html', '404.html',
  'work/robotics.html', 'work/websites.html', 'work/apps.html',
  'work/photography.html', 'work/marketing.html', 'work/hardware.html'
];

const explicit = process.argv[2] ? parseInt(process.argv[2], 10) : null;
if (explicit !== null && (!Number.isInteger(explicit) || explicit < 1)) {
  console.error('version must be a positive integer');
  process.exit(1);
}

const sources = await Promise.all(
  PAGES.map(async p => ({ page: p, html: await readFile(join(ROOT, p), 'utf8') }))
);

let highest = 0;
for (const { html } of sources) {
  for (const m of html.matchAll(/\?v=(\d+)/g)) {
    highest = Math.max(highest, parseInt(m[1], 10));
  }
}

const next = explicit ?? highest + 1;
let touched = 0;
let refs = 0;

for (const { page, html } of sources) {
  let count = 0;
  const out = html.replace(/\?v=\d+/g, () => { count++; return `?v=${next}`; });
  refs += count;
  if (out !== html) {
    await writeFile(join(ROOT, page), out);
    touched++;
  }
}

console.log(`stamped ${refs} references across ${touched} of ${PAGES.length} pages at v=${next}`);
