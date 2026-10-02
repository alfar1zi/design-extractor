# examples

Real end-to-end runs of `node scripts/cli.mjs <url> --out ./refs/<name>` (run from clone; not yet published to npm). The `.log` files are the full terminal output and prove the skill works on real production sites of different sizes.

## The three legacy sites (captured 2026-08-22, design-extractor v0.1)

| site | category | why useful as a reference |
| --- | --- | --- |
| itomdev.com | developer studio portfolio | tight, minimal design; small asset footprint; good for inspecting CSS token usage |
| linear.app | SaaS product marketing | long scroll page, heavy JS, animation-driven hero, well-structured component tree |
| stripe.com | enterprise SaaS marketing | massive asset set, multiple section patterns, complex layout at every breakpoint |

## Results summary (legacy, pre-P1-4)

All numbers from the log files. None estimated.

| site | source files | live artifacts | total | zip size | scroll shots | interactions (errored) | sweep |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| itomdev.com | 11 | 79 | 91 | 1451 KB | 1 | 34 (34) | tablet + mobile |
| linear.app  | 112 | 124 | 237 | 5860 KB | 14 | 50 (50) | tablet + mobile |
| stripe.com  | 288 | 130 | 419 | 61463 KB | 20 | 50 (50) | tablet + mobile |

"source files" = files extracted from the saveweb2zip download into `site/site/`.
"live artifacts" = files written by the Playwright inspect pass into `live/`.
"interactions (errored)" = clickables found in the a11y tree, how many errored during the click pass. These pre-P1-4 numbers all show 100% error rate under the now-removed `[role="..."]` filtered-by-text selector strategy.

## Current run (post-P1-4)

| log | site | clickables | hovers | errored | notes |
| --- | --- | ---: | ---: | ---: | --- |
| `examples/example-test.log` | example.com | 1 | 1 | 0 | most recent, smallest site, baseline |
| `examples/linear-v4.log` | linear.app | 20 | - | 5 | re-captured after Locator API migration; 15/20 succeeded |

The current interaction pass uses the Playwright Locator API (`page.locator(INTERACTION_SEL).nth(i)`) so the selector is re-resolved on each action and cannot drift into a stale handle. Before the click loop starts, `dismissOverlays()` clicks common cookie/consent banners so they do not intercept later clicks. Failures are no longer a single "error" string; each entry in `interactions.json` carries a `result` field with one of:

- `ok` — click landed, navigation recorded.
- `timeout` — click action did not become actionable within the configured timeout (8s). Likely SPA hydration delay.
- `not-found` — the locator resolved to zero elements at click time (rare under the new API; usually means the page re-rendered between probe and click).
- `intercepted` — another element was on top of the target (sticky header, modal backdrop, consent overlay that the dismiss pass missed).
- `error` — anything else (network, navigation, unexpected Playwright exception).

`interactions.json` and `hover.json` both use this schema.

## Honest limitations that remain

The interaction pass no longer fails wholesale, but the following are still true post-P1-4:

- **SPA hydration timing** can still produce `timeout` results. The current cap is 8 seconds per click; long-hydrating SPAs may need a future `--hydration-timeout` flag.
- **Shadow-DOM widgets** with custom elements that do not expose an `a[href]`, `button`, `[role="button"]`, `input[type="submit"]`, or `[tabindex="0"]` are not in `INTERACTION_SEL` and never get clicked. Add new selectors there to extend coverage.
- **Sweep viewports are fixed** at 1440x900, 768x1024, and 375x812. Custom viewport lists are not yet a CLI flag.

## How to reproduce

Run these commands after completing the install steps in the root `README.md` (Note: Not yet published to npm. Run from clone via `node` instead of `npx`):

```bash
node scripts/cli.mjs https://itomdev.com  --out ./refs/itomdev
node scripts/cli.mjs https://linear.app   --out ./refs/linear
node scripts/cli.mjs https://stripe.com   --out ./refs/stripe
```

Each run writes `site/` and `live/` into the target directory. The zip files are deleted after extraction.

## Reading order for the agent

Start with the source, then layer on the live signals:

1. `site/site/index.html`: entry point, framework fingerprint, section structure
2. `site/site/**/*.css`: CSS variables (`:root`, `--` custom props), Tailwind config if present
3. `live/screenshots/full.png`: the rendered page end-to-end in one image
4. `live/a11y-tree.json`: every named interactive element and their roles
5. `live/network.json`: fonts loaded, CDN assets, lazy-loaded images (cross-ref with source asset list)
6. `live/screenshots/scroll-*.png`: section-by-section rendered output in sequence
7. `live/screenshots/tablet.png`, `live/screenshots/mobile.png`: breakpoint behavior
8. `live/interactions.json`: per-element click result + `result` category. Skip entries where `result != "ok"` when counting what the user can actually click.
9. `live/hover.json`: per-element hover transition timing, measured as `max(duration_i + delay_i)` across the whole list, not the first value.
10. `live/motion.json`: every animation track, labelled by which of the four sources it came from.
11. `live/components.json`: framework-reported component boundaries. Read `live/components.inferred.json` separately; it is a guess, not a report.
12. `live/unproducible.json`: read this before promising a 1:1 rebuild. It names every canvas, cross-origin stylesheet and truncated sample the capture could not turn into DOM or CSS.

The `site/` and `live/` directories are not committed to the repo (they are in `.gitignore`). Only the `.log` files ship here as proof of the run. To get the full artifact folders for a given site, run the reproduction commands above.
