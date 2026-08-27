---
name: design-extractor
description: >
  Stop copying pixels. Screenshots miss the motion. Extract the actual source,
  computed tokens, and runtime behavior for AI agents. Downloads source via
  saveweb2zip, runs Playwright to extract screenshots, a11y tree, resolved CSS
  tokens, motion presence, and interaction data into a structured output folder.
  Invoke when asked to capture, clone, reference, or reverse-engineer a site's
  design. Do NOT use for code generation, content extraction, or SEO tasks.
argument-hint: "[url] [--output ./refs/name]"
license: MIT
---

# design-extractor: 1:1 Website Reference Capture

> Goal: faithful reference. No assumptions. See the files AND see the live page
> before anything is reused. Screenshots alone are NOT enough — this skill extracts
> the real source, reads it, then watches it move.

---

## 1. When to use / when NOT to use

Use when:
- User wants a 1:1 design reference from a live site ("ambil referensi dari [URL]", "bikin kayak site ini", "study this website", "redesign target", "extract design from", "reference capture").
- Building a taste-library intake before a redesign or a fresh build.
- Teardown for a specific site the user names or picks from a short list.

Do NOT use when:
- Single-page text read where the user only wants the content — use `webfetch`.
- One-off documentation lookup — use `webfetch` or a search tool.
- Screenshot-only mood board with no source motion — that's a screenshot tool, not this skill. This skill explicitly exists to fix the "PNG trap" where motion, interaction, breakpoints, and source architecture get lost.

Distinction from peers:
- `webfetch`: text from one URL, no source, no motion.
- Screenshot tools: pixels, no HTML/CSS/JS, no scroll/click recording.
- This skill: source AND runtime AND one merged reference doc.

---

## 2. The two-signal rule

Both signals are mandatory. Skip either and the reference is broken.

| Signal | Source | What it gives you |
|---|---|---|
| STATIC | Downloaded files (HTML, CSS, JS, images, fonts, config) | Tokens, component anatomy, asset paths, framework choice, build setup |
| LIVE | Rendered DOM via Playwright (scroll, click, resize, network) | Motion, hover, reveals, breakpoints, runtime-only DOM, lazy-loaded assets |

A screenshot covers neither signal. That is the trap this skill exists to fix.

---

## 3. Step 0 — Discover (optional)

When the user has no specific URL, generate 3 to 5 candidate sites:

```bash
npx design-extractor-find --prompt "premium modern SaaS landing dark theme" --count 5
```

**Backend recommendation**: prefer `--backend brave` (or `--backend auto` with `BRAVE_API_KEY` set). The default DuckDuckGo HTML scraper is zero-config but fragile: if its markup changes the parser now throws a distinct "DuckDuckGo HTML markup changed; parser needs update" error so you can tell parser miss apart from a genuine zero-result query. Brave is the reliable production path.

Filter the results: drop template-marketplace spam, drop aggregator pages, keep real product sites and studios. Present the candidates to the user and let them pick one or more. Never auto-commit to the first result. After the user picks, proceed to Step 1 with the chosen URL(s).

---

## 4. Step 1 — Download the real website

Primary path — saveweb2zip (server-side copy, full assets, zipped):

```bash
npx design-extractor-save https://target.example --out ./refs/target --rename-assets
```

Common flags (mirror the source site's options):

| Flag | Effect |
|---|---|
| `--rename-assets` | Rename hashed assets to readable names |
| `--save-structure` | Preserve the site's URL path layout |
| `--mobile-version` | Capture the mobile variant |
| `--alternative-algorithm` | Simplified static download fallback |

Automatic fallback. If saveweb2zip retries exhaust, `downloadSiteWithFallback` automatically tries `npx monolith` and then `npx single-file-cli` as best-effort fallbacks. Both require network access to the npm registry at runtime and a working `npx`; they may not be available in every sandbox. The skill exits with an error only after all three paths fail.

**SSRF Protection**: All network paths run a safety check to block local/private IP ranges. Pass `--allow-private` to permit loopback or private targets. Note that `assertSafeUrl` validates at check time only, so DNS rebinding between check and connect is theoretically possible. Pair with egress policy for high-trust environments.

Extract the output/zip into `./refs/target/site/` and keep the folder. This folder IS the reference artifact — never delete it mid-analysis.

---

## 5. Step 2 — Deep-read the source (static signal)

Walk the extracted tree and extract the design system before judging visuals.

1. Entry point. Open the main HTML file. Note sections, containers, nesting depth, semantic landmarks (`<header>`, `<main>`, `<section>`).
2. Tokens. Locate CSS variables — search for `:root`, `--`, `variables.css`, `tokens.css`, Tailwind config (`tailwind.config.*`), or theme files. Extract:
   - Palette (hex, rgb, oklch, hsl)
   - Type families, sizes, weights, line-heights
   - Spacing scale
   - Radii, shadows, z-index layers
   - Breakpoints
3. Components. Identify repeated blocks — nav, hero, card, pricing, CTA, footer, modal, accordion. Read the real markup and class names. Record each component's anatomy: grid/flex layout, position stacks, overlays, gradients, clip-path, backdrop-filter.
4. Assets. List images, SVG icons (note stroke width, fill rules, viewBox patterns), photos, video, web fonts. Keep their relative paths so they can be reused.
5. JS / interactions. Note animation libraries (GSAP, motion, framer-motion, vanilla), scroll handlers, hover/click behavior, cursor effects, page-load reveals. Record *what triggers what*.
6. Meta. Framework (React, Next, Vue, Svelte, static), build tool (Vite, webpack, Astro — read package/lockfile clues), how sections are composed.

This is the "files say it" half. End the read with an ordered architecture note: `[palette, typescale, spacing, components table, animations, assets]`.

Also check `live/tokens.json` (written by the inspect pass): it holds the resolved CSS custom property values that `getComputedStyle` sees at runtime. Static CSS files may declare vars that override each other at cascade layers; `tokens.json` shows the final resolved values. Compare against what you found in the source files.

---

## 6. Step 3 — Watch the live page (live signal)

Static source can miss runtime behavior — the page as the user experiences it.

### Capture modes

The inspect step supports three capture modes. Pick the one that matches your time budget and depth needs.

| Mode | Flag | What it does | Typical duration |
|---|---|---|---|
| Quick | `--quick` | CSS-native animation extraction only (source download + CSS/computed-style scan). No interaction, hover, scroll, or sweep passes. | 30s - 2min |
| Standard | default (no flag) | Interaction pass + hover pass + scroll pass + viewport sweep. CSS-native animation extraction. No sourcemap fetch or AST scan. This is the backward-compatible default. | 2-5min |
| Full | `--full` | Everything in Standard plus sourcemap fetch (same-origin, 5s timeout) and acorn AST scan for GSAP/ScrollTrigger call expressions. Detects canvas/WebGL elements for visual-only fallback. | 5-10min+ |

Individual `--no-scroll`, `--no-hover`, `--no-interactions`, `--no-sweep` flags still work as overrides after the preset is applied.

**Caveat on `--full`**: Sourcemap fetch may take significant time on sites with many JS bundles. Cross-origin sourcemaps that fail or timeout after 5 seconds fall back silently to the `js-inferred` tier. The scan does not block the rest of the capture.

```bash
npx design-extractor-inspect https://target.example --out ./refs/target/live --viewport 1440x900
# mode presets:
npx design-extractor-inspect ... --quick          # CSS-native only, fastest
npx design-extractor-inspect ... --standard       # default, backward-compatible
npx design-extractor-inspect ... --full           # all tiers including sourcemap + AST scan
# other flags:
npx design-extractor-inspect ... --record-video        # record scroll pass as .webm (slow)
npx design-extractor-inspect ... --site-dir ./refs/target/site  # scan downloaded JS for animation libs
```

Procedure:

1. Open the URL. Wait for load.
2. Dump the accessibility tree (`a11y-tree.json`) and extract interactive elements subset (`a11y-interactive.json`). Dump resolved CSS custom properties to `tokens.json` via `getComputedStyle`.
3. Scroll top-to-bottom using real `mouse.wheel()` events (not `window.scrollTo`) so IntersectionObserver callbacks fire. Capture screenshots at each 80% viewport-height step. Wait 1500ms per step for CSS transitions to complete.
4. Click up to 20 interactive elements. Each element is clicked in its own fresh page load to prevent stale handles from SPA navigation. Before the click loop, dismiss common cookie/consent overlays so they cannot intercept the click. Use the Playwright Locator API (`page.locator(INTERACTION_SEL).nth(i)`) so the selector re-resolves on every action. Record per element: index, selector, tag, role, name, href, navigated, result (`ok` / `timeout` / `not-found` / `intercepted` / `error`), error message, before-screenshot, after-screenshot. Results in `interactions.json`. A parallel hover pass writes the same shape (with `type: "hover"` and `transitionMs` from `getComputedStyle(el).transitionDuration`) to `hover.json`.
5. Resize across viewports. Test desktop (1440x900), tablet (768x1024), mobile (375x812). Full-page screenshot for each in `screenshots/`.
6. SPA / JS-render caveat. If the page is JS-rendered (React, Vue, hydration), the static download may hold only a shell. The browser DOM is the truth. Capture `page.content()` after load and diff against the downloaded HTML. This is exactly why Step 2 and Step 3 are both required.
7. Network pass. Reload with the network log on. Catch web fonts (woff2), lazy-loaded images, CDN-hosted scripts, third-party trackers. Cross-reference with the asset list from Step 2.
8. Animation lib scan. If `--site-dir` is passed, grep the downloaded JS for GSAP, Lenis, framer-motion, AOS, scrollReveal, and IntersectionObserver usage. Writes `animation-libs.json`.

### Fidelity tiers

Every animation or interaction captured is labeled with a fidelity tier. **Never treat lower-fidelity tiers as equivalent to higher ones.**

| Tier | Label | How it's captured | Fidelity | Caveat |
|---|---|---|---|---|
| CSS-native | `css-native` | `document.getAnimations()` + `CSSKeyframesRule` cross-check via CSSOM | Exact | Does NOT capture `requestAnimationFrame`-driven animations (including GSAP by default). |
| JS-sourcemap | `js-sourcemap` | Sourcemap fetched (same-origin, 5s timeout), acorn AST scan on reconstructed source | High (reconstructed) | Reconstructed from source, not verified against live runtime behavior. |
| JS-inferred | `js-inferred` | Acorn AST scan directly on minified bundle (fallback when sourcemap fails) | Low-medium | Static analysis of minified code. Property names are usually not mangled but this is not guaranteed. Treat as educated guess. |
| Visual-only | `visual-only` | Canvas/WebGL/Three.js detection via `document.querySelectorAll('canvas')` + WebGL context check | Reference only | No DOM/CSS representation exists to extract. Screenshot/video only for human reference, not reusable code. |

Results are written to separate JSON files per tier and merged into `manifest.json` under `motionCapture`:

```
manifest.json -> motionCapture
  mode: "quick" | "standard" | "full"
  cssNative: [...]       // from animations-css.json
  jsSourcemap: [...]     // from animations-js-sourcemap.json (--full only)
  jsInferred: [...]      // from animations-js-inferred.json (--full only, fallback)
  visualOnly: [...]      // canvas/WebGL detection results
```

When reading animation data from a captured reference, always check the `fidelity` field before using the result. `js-inferred` and `visual-only` are starting points for manual reconstruction, not drop-in code.

This is the "page as the user experiences it" half.

---

## 7. Step 4 — Merge into one reference doc

Write a single markdown file per site. Sections, in order:

```
# Reference: <site> by <owner>

1. DESIGN READ        one tagline: what the design actually is
2. DESIGN SYSTEM      tokens: use live/tokens.json for resolved values, cross-ref with source CSS vars
3. COMPONENTS         name -> real markup/CSS -> behavior (states, hover, motion)
4. LAYOUT MAP         section-by-section anatomy + breakpoint behavior
5. ANIMATIONS         trigger -> effect -> easing -> timing; check animation-libs.json for lib names
6. ASSETS             images / fonts / icons paths (copyable)
7. WHAT TO STEAL 1:1  exact CSS/JS hunks, exact copy, exact images
```

Keep one doc per site. Feed the doc into the taste library so a later build injects the tasted style instead of re-deriving it.

---

## 8. Output structure

After a full run, `./refs/target/` looks like:

```
refs/target/
  site/                   downloaded source (HTML, CSS, JS, images, fonts)
    index.html
    assets/
    css/
    js/
  live/                   browser pass output
    screenshots/          per-section, per-viewport PNGs
    a11y-tree.json        full accessibility tree dump
    a11y-interactive.json interactive elements only (capped at 200)
    tokens.json           resolved CSS custom properties from getComputedStyle
    dom.html              post-hydration DOM
    network.json          requests, fonts, lazy assets
    console.json          console messages and page errors
    interactions.json     click-pass results (fresh page per element)
    hover.json            hover pass results (transition timing + before/after)
    animation-libs.json   animation lib fingerprint scan (if --site-dir passed)
    animations-css.json   CSS-native animations (always captured)
    animations-js-sourcemap.json  JS animations from sourcemap (--full only)
    animations-js-inferred.json   JS animations from AST scan (--full only, fallback)
    sourcemap-recovered/  original source tree recovered from sourcemaps (--full only)
    videos/scroll.webm    scroll pass recording (if --record-video passed)
    manifest.json         summary of all artifacts + motionCapture section
  REFERENCE.md            merged Step 4 doc
```

The folder is the artifact. Hand it to a redesign build or a taste-library intake as-is.

---

## 9. Guards

- No assumptions. Testify from source OR from the DOM. When done, write one sentence naming which signal each claim came from ("I saw X in the HTML and executed Y in the browser; Z is 1:1").
- SPA / JS-render caveat. Static download may hold a shell. Browser pass is mandatory for any client-rendered site.
- Don't overwrite the reference folder. New renderings get suffixes; source files stay untouched.
- Copy respect. This skill is for the user's own learning and design study. Translate to a product only what they have rights to or a license for. Flag gated or licensed assets (fonts, stock photos, proprietary code) before reuse.
- Don't fabricate. If a token, component, or motion can't be confirmed in source or DOM, say so — do not guess.

---

## 10. Install

```bash
git clone https://github.com/alfar1zi/design-extractor.git
cd design-extractor
npm install
npm run install:browsers   # playwright chromium
```

Then use the commands from Steps 1, 3, and 0 above.

Requires Node 18+, Playwright Chromium.

---

## 11. Companion skill pointer

This skill is the intake for downstream design skills — `impeccable`, `design-taste-frontend`, `design-workflow`. It complements them by producing the faithful reference doc those skills consume; it does not replace them. Run this first to capture the source + motion truth, then hand the `reference.md` to the design workflow.
