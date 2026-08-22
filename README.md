# design-extractor

Capture 1:1 design references from any live website. Source, not screenshots.

## Why this exists

Screenshot-only references miss the things that actually make a design work: source architecture, animation timing, runtime DOM after hydration, and interaction state. This skill captures both signals -- the full downloaded source (HTML/CSS/JS/images) and the rendered runtime via a real browser -- and merges them into one reference folder you can read, search, and re-use.

## Install

Requires Node 18+ and a Chromium download for Playwright (~120MB, first run only).

```bash
git clone https://github.com/alfar1zi/design-extractor.git
cd design-extractor
npm install
npm run install:browsers
```

Or run the one-shot installer:

```bash
./install.sh            # macOS / Linux
pwsh ./install.ps1      # Windows (PowerShell 7+)
```

## Quick start

Three commands produce a complete reference folder under `./refs/<site>/`:

```bash
npx design-extractor          https://linear.app --out ./refs/linear
npx design-extractor-save     https://stripe.com  --out ./refs/stripe
npx design-extractor-inspect  https://itomdev.com --out ./refs/itomdev/live
```

The four bins:

| bin | purpose |
| --- | --- |
| `design-extractor`         | top-level orchestrator: save + inspect + REFERENCE.md in one shot |
| `design-extractor-save`    | download full site source via saveweb2zip into `<out>/site/` |
| `design-extractor-find`    | discover 3-5 reference candidates from a free-text prompt (DuckDuckGo, zero config; Brave if `BRAVE_API_KEY` is set) |
| `design-extractor-inspect` | drive a headless Chromium: screenshots, a11y tree, resolved tokens, DOM, network, console, scroll pass, viewport sweep; optional `--record-video` and `--site-dir` animation scan |

## What you get

```
refs/linear/
  site/                       downloaded source (HTML, CSS, JS, images, fonts)
    index.html
    css/
    js/
    assets/
  live/                       browser pass output
    screenshots/              per-section, per-viewport PNGs (viewport, full, scroll-NN, tablet, mobile)
    a11y-tree.json            full accessibility tree dump
    a11y-interactive.json     interactive elements only (capped at 200)
    tokens.json               resolved CSS custom property values from getComputedStyle
    dom.html                  post-hydration DOM
    network.json              every request: URL, method, status, content-type, size
    console.json              console messages and page errors
    interactions.json         click-pass results (one entry per interactive element)
    animation-libs.json       animation library fingerprint scan (if --site-dir given)
    videos/scroll.webm        scroll pass recording (if --record-video given)
    manifest.json             summary of all artifacts
  REFERENCE.md                starter template the agent fills in
```

The folder is the artifact. Hand it to a redesign build or a taste-library intake as-is.

## Proof it works

Three real runs already on disk in `examples/`. Numbers below are pulled directly from the log files, not estimated.

| site | source files | live files | total | zip size | scroll shots | sweep viewports |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| itomdev.com | 11 | 79 | 91 | 1451 KB  | 1  | tablet + mobile |
| linear.app  | 112 | 124 | 237 | 5860 KB  | 14 | tablet + mobile |
| stripe.com  | 288 | 130 | 419 | 61463 KB | 20 | tablet + mobile |

The v0.1 runs had all interaction-pass clicks fail because the old locator used role+name string matching, which breaks on shadow DOM, custom elements, and aria attributes that differ between the a11y tree and the live DOM. The current implementation uses `page.$$()` with a broad CSS selector (`a[href], button:not([disabled]), [role="button"]:not([disabled]), input[type="submit"], [tabindex="0"]`) and opens a fresh page per element so stale handles from SPA navigation are impossible. Click results (before/after screenshots, navigated flag, error) are recorded in `live/interactions.json` and the run continues on error.

Tracked in `examples/itomdev.log`, `examples/linear.log`, `examples/stripe.log`.

## How it works

Two signals, both required.

**Static signal.** `design-extractor-save` POSTs the URL to the saveweb2zip API (or falls back to `monolith` / `single-file-cli` if the API rate-limits) and extracts the returned zip into `<out>/site/`. This is the real source the site serves: HTML, CSS, JS, images, fonts, and any referenced assets. Read these files to extract the design system (CSS variables, Tailwind config, component markup, asset paths, animation libraries).

**Live signal.** `design-extractor-inspect` opens the URL in headless Chromium at a configurable viewport (default 1440x900), waits for network idle, then captures: a full-page screenshot, the accessibility tree (`a11y-tree.json`), the interactive-elements subset (`a11y-interactive.json`), the post-hydration DOM, every network request, every console message. It also dumps resolved CSS custom property values via `getComputedStyle` into `tokens.json` -- recovering the actual palette, easing curves, and shadow values that static CSS files miss when tokens are injected at runtime. It scrolls top-to-bottom using `page.mouse.wheel()` in 120px steps (triggering real IntersectionObserver callbacks, not teleport scrolls) and takes a screenshot at each 80% viewport-height stop. It re-opens the page at tablet (768x1024) and mobile (375x812) for a full-page screenshot each. The interaction pass opens a fresh Playwright page per element (preventing stale handles from SPA navigation) and clicks up to 20 elements using a broad CSS selector. Pass `--site-dir <path>` to scan the downloaded source for animation libraries (GSAP, Lenis, framer-motion, and others) and write `animation-libs.json`. Pass `--record-video` to record the scroll pass as a `.webm` video (off by default; adds 3-5x runtime). All output goes into `<out>/live/`.

The orchestrator `design-extractor` runs save then inspect, then writes a `REFERENCE.md` stub with all seven sections from the skill spec (design read, design system, components, layout, animations, assets, what-to-steal 1:1). The stub has placeholders, not invented content -- the agent fills in the design judgment from the captured artifacts.

This beats screenshot tools because you get the actual source to read, the runtime DOM to diff, and the motion to study, all in one folder.

## Companion skills

This skill is the **intake** for design work. It produces the faithful reference document the following skills consume:

- **impeccable** -- design quality bar, applied after intake
- **design-taste-frontend** -- taste library that holds tokens and component handouts
- **design-workflow** -- end-to-end flow that uses this skill at Phase 1

Point your agent at `SKILL.md` to load the skill spec via standard frontmatter discovery (Claude Code, OpenCode, Hermes, Cursor, etc.).

## Contributing

See [AGENTS.md](./AGENTS.md) for the operating rules.

Hard rule, repeated for emphasis: **no AI in git history.** No agent (Claude, OpenCode, Hermes, Cursor, GPT, Copilot, or any other) may commit, push, or appear as a git author or co-author. Only the human owner `alfar1zi`. No `Co-authored-by: <AI>` trailers in commit messages. This is a hard rule, not a preference.

## License

[MIT](./LICENSE)

## Maintainer

[@alfar1zi](https://github.com/alfar1zi)
