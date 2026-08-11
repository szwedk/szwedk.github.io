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
- Cache busting: every css/js reference carries `?v=N`. Bump N on every
  deploy that touches those files, on every page, or Pages serves stale
  assets for up to ten minutes.
- Classes are prefixed per feature (`ks-gait-lab-`, `ks-brief-`, ...) so
  the pairs stay isolated.

## Adding a project

Copy an `<article class="project">` block on the relevant `work/` page.
Photos go in `assets/` via the commented `.project-media` figure slot.
