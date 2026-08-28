/* =============================================================================
   Site audit. Loads every page in headless chromium and fails the build on
   anything that would look broken to a visitor: dead links, console errors,
   missing alt text, heading jumps, sub-24px tap targets, missing metadata,
   and drifted cache stamps.

   Local:  node tools/audit.mjs
   CI:     .github/workflows/audit.yml runs it on every push and PR.

   Exits 1 on any finding. Set AUDIT_BASE to point at a running server, or
   let it start its own on port 8899.
   ========================================================================== */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, access, readdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8899;

/* Pages are discovered, not listed, so a new note or work page is audited
   the moment it exists. Underscore-prefixed files are scaffolding, like
   notes/_template.html, and stay out. */
async function discoverPages() {
  const out = [];
  for (const dir of ['', 'work', 'notes', 'socials']) {
    let entries = [];
    try { entries = await readdir(join(ROOT, dir || '.')); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.html') || f.startsWith('_')) continue;
      out.push(dir ? `${dir}/${f}` : f);
    }
  }
  return out.sort();
}
const PAGES = await discoverPages();

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.woff2': 'font/woff2', '.xml': 'application/xml',
  '.txt': 'text/plain'
};

const findings = [];
const note = (page, msg) => findings.push(`${page}: ${msg}`);

/* ---- static server ------------------------------------------------------ */
function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const path = decodeURIComponent(req.url.split('?')[0]);
      let file = join(ROOT, path === '/' ? 'index.html' : path);
      try {
        /* Pages resolves a directory to its index.html and 301s the
           trailing slash on. Without that here, /socials/ is a 404 in the
           audit while it is the real published URL in production, so a
           correct link to it would fail the build. */
        let body;
        try {
          body = await readFile(file);
        } catch {
          file = join(file, 'index.html');
          body = await readFile(file);
        }
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(PORT, () => resolve(server));
  });
}

/* ---- cache stamps must agree across every page --------------------------
   A stylesheet edit with a stale ?v= is invisible for up to ten minutes on
   Pages, which reads as "the fix did not deploy". Catch the drift here. */
async function checkStamps() {
  const stamps = new Map();
  for (const page of PAGES) {
    const html = await readFile(join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/\?v=(\d+)/g)) {
      if (!stamps.has(m[1])) stamps.set(m[1], []);
      if (!stamps.get(m[1]).includes(page)) stamps.get(m[1]).push(page);
    }
  }
  if (stamps.size > 1) {
    const detail = [...stamps.entries()]
      .map(([v, pages]) => `v=${v} on ${pages.join(', ')}`).join(' | ');
    note('cache stamps', `versions have drifted: ${detail}. Run node tools/stamp.mjs`);
  }
  return stamps;
}

/* ---- per-page DOM checks ------------------------------------------------ */
const domChecks = () => {
  const out = [];

  const ids = {};
  document.querySelectorAll('[id]').forEach(e => { ids[e.id] = (ids[e.id] || 0) + 1; });
  Object.entries(ids).filter(([, n]) => n > 1)
    .forEach(([k, n]) => out.push(`duplicate id #${k} appears ${n} times`));

  document.querySelectorAll('img').forEach(i => {
    if (!i.hasAttribute('alt')) out.push(`img without alt: ${i.getAttribute('src')}`);
  });

  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => +h.tagName[1]);
  const h1s = levels.filter(l => l === 1).length;
  if (h1s !== 1) out.push(`page has ${h1s} h1 elements, expected exactly 1`);
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) out.push(`heading jumps h${levels[i - 1]} to h${levels[i]}`);
  }

  document.querySelectorAll('a,button').forEach(e => {
    const name = (e.getAttribute('aria-label') || e.textContent || '').trim();
    if (!name) out.push(`${e.tagName.toLowerCase()} with no accessible name: ${e.className || 'unclassed'}`);
  });

  document.querySelectorAll('a[href^="#"]').forEach(a => {
    const id = a.getAttribute('href').slice(1);
    if (id && !document.getElementById(id)) out.push(`anchor points nowhere: ${a.getAttribute('href')}`);
  });

  /* WCAG 2.2 target size (minimum). sr-only helpers are 1px by design,
     and links flowing inside a sentence are exempt under the rule's own
     inline exception, so only block-ish targets are measured. */
  document.querySelectorAll('a,button,input,select').forEach(e => {
    const b = e.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return;
    if (b.width <= 2 && b.height <= 2) return;
    if (e.tagName === 'A' && getComputedStyle(e).display === 'inline') return;
    if (Math.min(b.width, b.height) < 22) {
      const label = (e.textContent || e.className || e.type || '').trim().slice(0, 30);
      out.push(`tap target ${Math.round(b.width)}x${Math.round(b.height)}: ${label}`);
    }
  });

  if (!document.querySelector('meta[name="description"]')) out.push('no meta description');
  if (!document.querySelector('link[rel="canonical"]') &&
      !document.querySelector('meta[name="robots"][content*="noindex"]')) {
    out.push('no canonical link');
  }
  if (!document.querySelector('meta[property="og:title"]') &&
      !document.querySelector('meta[name="robots"][content*="noindex"]')) {
    out.push('no og:title');
  }

  return out;
};

/* ---- run ---------------------------------------------------------------- */
const server = await serve();
const base = process.env.AUDIT_BASE || `http://localhost:${PORT}`;

/* CI installs chromium where playwright expects it. Some sandboxes ship a
   prebuilt one instead, so honour PW_CHROMIUM and fall back to the common
   preinstall path before giving up. */
async function launch() {
  const candidates = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium'].filter(Boolean);
  for (const executablePath of candidates) {
    try {
      await access(executablePath);
      return await chromium.launch({ executablePath });
    } catch { /* try the next one */ }
  }
  return chromium.launch();
}
const browser = await launch();

await checkStamps();

for (const page of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const tab = await ctx.newPage();
  const runtime = [];

  tab.on('pageerror', e => runtime.push(`uncaught: ${String(e).slice(0, 160)}`));
  tab.on('console', m => { if (m.type() === 'error') runtime.push(`console error: ${m.text().slice(0, 160)}`); });
  tab.on('requestfailed', r => {
    const url = r.url().replace(base, '');
    if (!url.startsWith('data:')) runtime.push(`request failed: ${url}`);
  });
  tab.on('response', r => {
    if (r.status() >= 400) runtime.push(`${r.status()} on ${r.url().replace(base, '')}`);
  });

  /* which js/features modules this page actually pulled, so a declared
     mount that never loads can be told apart from one that loaded fine */
  const fetched = new Set();
  tab.on('request', r => {
    const m = /\/js\/features\/([a-z0-9-]+\.js)/.exec(r.url());
    if (m) fetched.add(m[1]);
  });

  await tab.goto(`${base}/${page}`, { waitUntil: 'networkidle' });
  /* reveal-on-scroll content is visibility:hidden until it scrolls in, and
     hidden elements have no box to measure, so unhide the same way a Tab
     press does before measuring targets */
  await tab.evaluate(() => document.documentElement.classList.add('kb-nav'));
  await tab.waitForTimeout(1200);

  /* Walk the whole page before measuring. Features are lazily mounted by an
     IntersectionObserver at rootMargin 100%, so anything more than one
     viewport below the fold never loaded here: gait-lab, push-g1, teleop and
     contact-sheet, four of the eleven modules and the three most involved,
     were never once executed by this audit. Their syntax was checked and
     nothing else. Stepping down the page mounts them, which puts their
     constructors under the pageerror and console listeners above. */
  await tab.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.75);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 90));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 400));
    window.scrollTo(0, 0);
  });
  await tab.waitForTimeout(1600);

  /* a mount that declares a module and never pulls it is a feature nobody
     is testing, which is how this gap opened in the first place */
  const declared = await tab.evaluate(() =>
    [...document.querySelectorAll('[data-ks-lazy]')]
      .map(e => (e.getAttribute('data-ks-lazy') || '').split('/').pop().split('?')[0])
      .filter(Boolean));
  for (const mod of [...new Set(declared)]) {
    if (!fetched.has(mod)) {
      note(page, `feature ${mod} is declared but never loaded, so nothing here exercises it`);
    }
  }

  (await tab.evaluate(domChecks)).forEach(f => note(page, f));
  runtime.forEach(f => note(page, f));

  /* every relative link must resolve */
  const hrefs = await tab.evaluate(() => [...document.querySelectorAll('a[href]')]
    .map(a => a.getAttribute('href'))
    .filter(h => h && !/^(#|mailto:|tel:|https?:|data:)/.test(h)));
  for (const href of [...new Set(hrefs)]) {
    const target = new URL(href, `${base}/${page}`).toString();
    const res = await tab.request.get(target).catch(() => null);
    if (!res || res.status() >= 400) note(page, `broken link ${href} (${res ? res.status() : 'unreachable'})`);
  }

  await ctx.close();
}

/* the notes manifest, the files on disk, and the sitemap must agree,
   or the vault silently drifts as it grows */
{
  let manifest = null;
  try { manifest = JSON.parse(await readFile(join(ROOT, 'assets/notes.json'), 'utf8')); }
  catch (e) { note('assets/notes.json', `unreadable or invalid JSON: ${e.message}`); }
  if (manifest) {
    const fieldIds = new Set((manifest.fields || []).map(f => f.id));
    const noteIds = new Set((manifest.notes || []).map(n => n.id));
    for (const f of manifest.fields || []) {
      await access(join(ROOT, f.href)).catch(() => note('assets/notes.json', `field ${f.id} points at missing ${f.href}`));
    }
    for (const n of manifest.notes || []) {
      await access(join(ROOT, n.href)).catch(() => note('assets/notes.json', `note ${n.id} points at missing ${n.href}`));
      for (const fid of n.fields || []) {
        if (!fieldIds.has(fid)) note('assets/notes.json', `note ${n.id} references unknown field ${fid}`);
      }
      for (const lid of n.links || []) {
        if (!noteIds.has(lid)) note('assets/notes.json', `note ${n.id} links to unknown note ${lid}`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(n.date || '')) note('assets/notes.json', `note ${n.id} has a malformed date`);
    }
    const manifested = new Set((manifest.notes || []).map(n => n.href));
    for (const page of PAGES) {
      if (page.startsWith('notes/') && !manifested.has(page)) {
        note(page, 'exists on disk but is missing from assets/notes.json, so the vault will not show it');
      }
    }
  }

  /* every indexable page belongs in the sitemap */
  const sitemap = await readFile(join(ROOT, 'sitemap.xml'), 'utf8');
  for (const page of PAGES) {
    const html = await readFile(join(ROOT, page), 'utf8');
    if (/name="robots"[^>]*noindex/.test(html)) continue;
    const loc = page === 'index.html' ? 'https://kamilszwed.com/' : `https://kamilszwed.com/${page}`;
    if (!sitemap.includes(`<loc>${loc}</loc>`)) note(page, 'not listed in sitemap.xml');
  }
}

/* sitemap entries must all resolve */
{
  const sitemap = await readFile(join(ROOT, 'sitemap.xml'), 'utf8');
  const ctx = await browser.newContext();
  const tab = await ctx.newPage();
  for (const m of sitemap.matchAll(/<loc>https:\/\/kamilszwed\.com(\/[^<]*)<\/loc>/g)) {
    const path = m[1] === '/' ? '/index.html' : m[1];
    const res = await tab.request.get(`${base}${path}`).catch(() => null);
    if (!res || res.status() >= 400) note('sitemap.xml', `${m[1]} does not resolve`);
  }
  await ctx.close();
}

await browser.close();
server.close();

if (findings.length) {
  console.error(`\nAUDIT FAILED, ${findings.length} finding${findings.length === 1 ? '' : 's'}:\n`);
  findings.forEach(f => console.error(`  - ${f}`));
  console.error('');
  process.exit(1);
}
console.log(`\nAudit clean across ${PAGES.length} pages.\n`);
