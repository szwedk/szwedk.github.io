# kamilszwed.com

Personal portfolio of Kamil Szwed — robots, websites, apps, photography,
marketing, and custom hardware.

Static site, hand-written HTML/CSS/JS. GSAP + ScrollTrigger + Lenis are
vendored in `vendor/`; fonts are self-hosted in `fonts/`. No build step —
GitHub Pages serves this branch as-is.

- `index.html` — home: scroll-scrubbed particle hero, manifesto, timeline,
  expandable work index, toolkit, contact
- `work/*.html` — one page per field, each a list of projects
- To add a project: copy an `<article class="project">` block on the
  relevant `work/` page; photos go in `assets/` via the commented
  `.project-media` figure slot
