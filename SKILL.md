---
name: design-extractor
description: Use when the user wants a 1:1 design reference from a live website. Capture the real source (HTML/CSS/JS/images), not just a screenshot. Downloads the site, deep-reads the design system, drives a real browser to record motion/interactions/breakpoints, then writes a single reference doc covering tokens, components, layout, animations, assets. Feeds taste libraries and redesign builds. Triggers on "ambil referensi dari [URL]", "bikin kayak site ini", "study this website", "extract design from", "redesign target", "reference capture". NOT for reading one public docs page (use webfetch), or quick lookups.
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

Fallbacks when saveweb2zip errors, rate-limits, or the site blocks the service:

```bash
# monolith: one page to one standalone HTML with assets inlined
npx monolith https://target.example -o page.html

# single-file-cli: headless Chromium renders JS into one HTML file
npx single-file-cli https://target.example --output-dir ./refs/target
```

Extract the zip into `./refs/target/site/` and keep the folder. This folder IS the reference artifact — never delete it mid-analysis.

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

```bash
npx design-extractor-inspect https://target.example --out ./refs/target/live --viewport 1440x900
# optional flags:
npx design-extractor-inspect ... --record-video        # record scroll pass as .webm (slow)
npx design-extractor-inspect ... --site-dir ./refs/target/site  # scan downloaded JS for animation libs
```

Procedure:

1. Open the URL. Wait for load.
2. Dump the accessibility tree (`a11y-tree.json`) and extract interactive elements subset (`a11y-interactive.json`). Dump resolved CSS custom properties to `tokens.json` via `getComputedStyle`.
3. Scroll top-to-bottom using real `mouse.wheel()` events (not `window.scrollTo`) so IntersectionObserver callbacks fire. Capture screenshots at each 80% viewport-height step. Wait 1500ms per step for CSS transitions to complete.
4. Click up to 20 interactive elements. Each element is clicked in its own fresh page load to prevent stale handles from SPA navigation. Record: before-screenshot, after-screenshot, navigated flag, after URL, error. Results in `interactions.json`.
5. Resize across viewports. Test desktop (1440x900), tablet (768x1024), mobile (375x812). Full-page screenshot for each in `screenshots/`.
6. SPA / JS-render caveat. If the page is JS-rendered (React, Vue, hydration), the static download may hold only a shell. The browser DOM is the truth. Capture `page.content()` after load and diff against the downloaded HTML. This is exactly why Step 2 and Step 3 are both required.
7. Network pass. Reload with the network log on. Catch web fonts (woff2), lazy-loaded images, CDN-hosted scripts, third-party trackers. Cross-reference with the asset list from Step 2.
8. Animation lib scan. If `--site-dir` is passed, grep the downloaded JS for GSAP, Lenis, framer-motion, AOS, scrollReveal, and IntersectionObserver usage. Writes `animation-libs.json`.

This is the "page as the user experiences it" half.

---

## 7. Step 4 — Merge into one reference doc

Write a single markdown file per site. Sections, in order:

```
# Reference: <site> by <owner>

1. DESIGN READ        one tagline: what the design actually is
2. DESIGN SYSTEM      tokens -- use live/tokens.json for resolved values, cross-ref with source CSS vars
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
    animation-libs.json   animation lib fingerprint scan (if --site-dir passed)
    videos/scroll.webm    scroll pass recording (if --record-video passed)
    manifest.json         summary of all artifacts
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
