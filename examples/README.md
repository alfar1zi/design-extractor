# examples

Three real end-to-end runs, captured 2026-08-22.

These `.log` files are the full terminal output of `npx design-extractor <url> --out ./refs/<name>` runs. They prove the skill works end-to-end on real production sites of different sizes.

All three runs were captured on the same day using design-extractor v0.1.

## The three sites

| site | category | why useful as a reference |
| --- | --- | --- |
| itomdev.com | developer studio portfolio | tight, minimal design; small asset footprint; good for inspecting CSS token usage |
| linear.app | SaaS product marketing | long scroll page, heavy JS, animation-driven hero, well-structured component tree |
| stripe.com | enterprise SaaS marketing | massive asset set, multiple section patterns, complex layout at every breakpoint |

## Results summary

All numbers from the log files. None estimated.

| site | source files | live artifacts | total | zip size | scroll shots | interactions (errored) | sweep |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| itomdev.com | 11 | 79 | 91 | 1451 KB | 1 | 34 (34) | tablet + mobile |
| linear.app  | 112 | 124 | 237 | 5860 KB | 14 | 50 (50) | tablet + mobile |
| stripe.com  | 288 | 130 | 419 | 61463 KB | 20 | 50 (50) | tablet + mobile |

"source files" = files extracted from the saveweb2zip download into `site/site/`.
"live artifacts" = files written by the Playwright inspect pass into `live/`.
"interactions (errored)" = clickables found in the a11y tree, how many errored during the click pass.

## What each run produced

**itomdev.com.** Small site: 11 source files, 1451 KB zip. The downloaded source contains a single `index.html`, a handful of CSS files, a few images, and no bundled JS framework (static HTML with minimal scripting). The live capture ran at 1440x900, took 1 scroll screenshot (the page fits in one viewport), found 34 interactive elements in the a11y tree, and swept tablet and mobile. Live artifacts: 79 files total, including the full-page screenshot, accessibility tree, post-hydration DOM, network log, and console log.

**linear.app.** Mid-size site: 112 source files, 5860 KB zip. The downloaded source includes a Next.js static export shell with bundled CSS and chunked JS. The live capture scrolled through 14 positions and took a screenshot at each, confirming a long animated marketing page. 50 clickable elements found (the cap). Sweep produced tablet and mobile full-page screenshots. Live artifacts: 124 files: the scroll pass alone produces 14 screenshots.

**stripe.com.** Large site: 288 source files, 61463 KB zip (61 MB). The saveweb2zip API required two poll cycles before `isFinished` (visible in the log: `copied=288 finished=false` then `finished=true`). The downloaded source is a full asset tree: HTML, CSS, JS chunks, images, and fonts across multiple directories. The live capture scrolled 20 positions, the longest scroll pass of the three runs, producing 20 scroll screenshots plus the full-page and viewport shots. 50 clickables found (the 50-element cap was hit immediately; the real interactive count is higher). Sweep produced tablet and mobile full-page screenshots. Live artifacts: 130 files.

## Honest limitations

The interaction pass (which clicks each interactive element, takes a before/after screenshot, and records the DOM diff) **errored on every element in all three runs** (34/34, 50/50, 50/50). The run does not abort; errors are captured in `live/interactions.json` per element. The cause is fragile selector synthesis in v0.1: the locator is built from `[role="..."]` filtered by text content, which fails on production sites that use shadow DOM, custom elements, or aria roles that differ between the serialized a11y tree and the live DOM.

What works in v0.1:
- Source download (saveweb2zip)
- Full-page and viewport screenshots
- Scroll-through screenshot pass
- Tablet + mobile viewport sweep
- Accessibility tree dump
- Post-hydration DOM capture
- Network request log
- Console message log
- REFERENCE.md stub generation

The interaction click pass is tracked and will be fixed in v0.2 (see the `interactionPass` function in `scripts/inspect.mjs`).

## How to reproduce

Run these commands after completing the install steps in the root `README.md`:

```bash
npx design-extractor https://itomdev.com  --out ./refs/itomdev
npx design-extractor https://linear.app   --out ./refs/linear
npx design-extractor https://stripe.com   --out ./refs/stripe
```

Each run writes `site/`, `live/`, and `REFERENCE.md` into the target directory. The zip files are deleted after extraction.

## Reading order for the agent

Start with the source, then layer on the live signals:

1. `site/site/index.html`: entry point, framework fingerprint, section structure
2. `site/site/**/*.css`: CSS variables (`:root`, `--` custom props), Tailwind config if present
3. `live/screenshots/full.png`: the rendered page end-to-end in one image
4. `live/a11y-tree.json`: every named interactive element and their roles
5. `live/network.json`: fonts loaded, CDN assets, lazy-loaded images (cross-ref with source asset list)
6. `live/screenshots/scroll-*.png`: section-by-section rendered output in sequence
7. `live/screenshots/tablet.png`, `live/screenshots/mobile.png`: breakpoint behavior
8. `REFERENCE.md`: fill in each section using the above artifacts

The `site/` and `live/` directories are not committed to the repo (they are in `.gitignore`). Only the `.log` files ship here as proof of the run. To get the full artifact folders for a given site, run the reproduction commands above.
