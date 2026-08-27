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

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Discovered, not listed. Underscore-prefixed files are scaffolding and stay
   out of the audit's page walk, but they ARE stamped: notes/_template.html
   sat at v=22 for weeks because it was skipped here, so every note copied
   from it started life with a stale stamp. */
async function discoverPages() {
  const out = [];
  for (const dir of ['', 'work', 'notes', 'socials']) {
    let entries = [];
    try { entries = await readdir(join(ROOT, dir || '.')); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.html')) continue;
      out.push(dir ? `${dir}/${f}` : f);
    }
  }
  return out.sort();
}
const PAGES = await discoverPages();

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

/* ---- sitemap lastmod, from git rather than from memory -------------------
   Every one of the twelve dates in sitemap.xml was stale, some by a month,
   because they were hand-written and nothing made anyone come back. The only
   machine-readable freshness signal the site emits was wrong on every page.
   It is derived now, so it cannot drift again. */
function lastCommitted(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', file],
                             { cwd: ROOT, encoding: 'utf8' }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch { return null; }
}

{
  const path = join(ROOT, 'sitemap.xml');
  let xml = await readFile(path, 'utf8');
  let fixed = 0;
  xml = xml.replace(
    /<loc>https:\/\/kamilszwed\.com(\/[^<]*)<\/loc>(\s*)<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g,
    (whole, urlPath, gap, was) => {
      const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '');
      const now = lastCommitted(file);
      if (!now || now === was) return whole;
      fixed++;
      return `<loc>https://kamilszwed.com${urlPath}</loc>${gap}<lastmod>${now}</lastmod>`;
    });
  await writeFile(path, xml);
  console.log(fixed
    ? `sitemap: ${fixed} lastmod date${fixed === 1 ? '' : 's'} corrected from git`
    : 'sitemap: lastmod dates already match git');
}
