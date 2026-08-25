# kamilszwed.com

Personal portfolio of Kamil Szwed: robots, websites, apps, photography,
marketing, and custom hardware.

Hand-written HTML/CSS/JS. No frameworks, no build step, no CDNs. GSAP +
ScrollTrigger + Lenis are vendored in `vendor/`, fonts are self-hosted in
`fonts/`, and GitHub Pages serves the branch as-is at the custom domain.

## Map

- `index.html` · home: scroll-scrubbed particle hero, manifesto word
  assembly, career timeline, expandable work index, toolkit, contact
- `work/*.html` · one page per field (robotics, websites, apps,
  photography, marketing, hardware), each with projects and a next-field
  link so the six pages read as a loop
- `brief.html` · guided five-question intake that composes a structured
  brief into an email; no backend, nothing stored
- `404.html` · the page that dissolves; all URLs root-absolute because
  Pages serves it from whatever missing path was requested
- `notes.html` · the vault: an Obsidian-style force graph of every note
  plus the chronological index, both drawn from `assets/notes.json`
- `notes/*.html` · one page per note; `notes/_template.html` is the
  copy-me scaffold (underscore keeps it out of audit, stamp, and sitemap)
- `assets/og-card.html` · source artwork for the 1200x630 share card,
  screenshot it to regenerate `assets/og-card.jpg`
- `assets/robot-kinematics.json` · link lengths and joint limits parsed
  from the official Unitree G1 and Go2 URDFs

## Interactive features

Each one is a self-mounting `js/features/*.js` + `css/features/*.css`
pair. It finds its `[data-ks-*]` attribute, builds its DOM inside, and
does nothing if the attribute is absent.

| Feature | Mount | Lives on |
|:--------|:------|:---------|
| Push the Humanoid | `data-ks-push-g1` | work/robotics.html |
| Gait Lab | `data-ks-gait-lab` | work/robotics.html |
| IntelliPARK Sandbox | `data-ks-intellipark` | work/apps.html |
| The Contact Sheet | `data-ks-contact-sheet` | work/photography.html |
| Wordmark Reprint | `data-ks-wordmark` | work/hardware.html |
| The Brief | `data-ks-brief` | brief.html |
| GO2 | none (type `go2`) | index.html |

The robot demos use the real URDF numbers from
`assets/robot-kinematics.json` and say so on screen.

## Conventions

- Motion: the header switch writes `localStorage["ks-motion"]`, which
  outranks `prefers-reduced-motion`. Every feature honors it; still mode
  keeps things usable without autonomous animation.
- Cache busting: every css/js reference carries `?v=N`. Bump it with
  `node tools/stamp.mjs` after any css or js change, never by hand.
  Pages serves assets with `max-age=600`, so a stale stamp means up to
  ten minutes of visitors getting the old file and the fix looking like
  it never deployed.
- Classes are prefixed per feature (`ks-gait-lab-`, `ks-brief-`, ...) so
  the pairs stay isolated.

## Checks

```
node tools/stamp.mjs      bump every ?v= stamp to one number
node tools/audit.mjs      load every page and fail on anything broken
```

The audit discovers every page (root, work/, notes/) and walks each one
in headless chromium, exiting non-zero
on dead links, uncaught exceptions, console errors, 4xx responses,
missing alt text, duplicate ids, heading-level jumps, controls with no
accessible name, sub-24px tap targets, missing metadata, unresolvable
sitemap entries, and drifted cache stamps. `.github/workflows/audit.yml`
runs it plus a syntax check and an em-dash sweep on every push and pull
request.

## Adding a note

1. Copy `notes/_template.html` to `notes/your-slug.html` and follow the
   checklist in its top comment (title, canonical, prose, linked list,
   remove the noindex line).
2. Add the note to `assets/notes.json`: id, title, date, fields, links,
   minutes, summary, href. The graph and the list both draw from this
   file, so a note that is not in it does not exist.
3. Add a `<url>` line to `sitemap.xml`.
4. Run `node tools/stamp.mjs` then `node tools/audit.mjs`. The audit
   cross-checks the manifest against the files on disk and the sitemap,
   so a missed step fails the build instead of shipping a half-wired
   note.

## Adding a project

Copy an `<article class="project">` block on the relevant `work/` page.
Photos go in `assets/` via the commented `.project-media` figure slot.
