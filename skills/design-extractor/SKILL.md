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
npx design-extractor-inspect ... --target ".pricing-card" --target "nav"  # one element, not the page
```

**Choosing what to clone.** The user decides, and the flag is the whole decision.
No `--target` captures the page. With `--target <css>` (repeatable) each match is
captured as a self-contained unit in `targets.json`: outer HTML, the computed
styles for 37 properties, its hover and focus states with the *measured*
transition, and a screenshot cropped to it. A selector that matches nothing is
recorded as `found: false` with a reason rather than throwing, so one stale
selector does not lose the other captures. A run where *every* selector matches
nothing exits non-zero instead: that is a typo, and a directory of artifacts
scoped to nothing is indistinguishable from a successful capture.

`--target` also scopes the analysis. `motion.json`, `components.authoritative.json`,
`components.inferred.json` and `tokens.json` describe only what is inside the
matched subtrees and each records the `scope` it ran under; `tokens.json` gains
`scopedProperties`, the custom properties in force on those elements rather than
the ones the stylesheets declare. The tree, the accessibility tree and the
screenshots stay whole, because a tree cut to a subtree loses the ancestor chain
that positions it and will not render. When the user asks to clone a
component, run `--target` on it. When they ask to clone the page, run the full
capture and read `components.authoritative.json`.

Procedure:

1. Open the URL. Wait for load.
2. Dump the accessibility tree (`a11y-tree.json`) and extract interactive elements subset (`a11y-interactive.json`). Write `tokens.json`: `customProperties` are the custom properties the site named on the root and body, `derived` is a DTCG token set read off every rule in the cascade. Walk `document.styleSheets` plus open shadow roots' `adoptedStyleSheets`; a cross-origin stylesheet throws on `cssRules` and is skipped, not crashed on.
3. Scroll top-to-bottom using real `mouse.wheel()` events (not `window.scrollTo`) so IntersectionObserver callbacks fire. Capture screenshots at each 80% viewport-height step. Wait 1500ms per step for CSS transitions to complete.
4. Click up to 20 interactive elements, on ONE page load for the whole sweep, reloading only when a click actually navigated (`page.url()` changed). A fresh load per element cost a full navigation each time and, worse, measured every element against a different render of the page. The reload is what keeps `nth=i` meaning the same element: after a navigation the list is a different list. Hovering never navigates, so `hoverPass` uses one load and no reloads. Dismiss common cookie/consent overlays before each element, not once: a click can leave one open over the next target. Use the Playwright Locator API (`page.locator(INTERACTION_SEL).nth(i)`) so the selector re-resolves on every action. Record per element: index, selector, tag, role, name, href, navigated, result (`ok` / `timeout` / `not-found` / `intercepted` / `error`), error message, before-screenshot, after-screenshot. Results in `interactions.json`. A parallel hover pass writes the same shape (with `type: "hover"` and `transitionMs` from `getComputedStyle(el).transitionDuration`) to `hover.json`.
5. Resize across viewports. Test desktop (1440x900), tablet (768x1024), mobile (375x812). Full-page screenshot for each in `screenshots/`.
6. SPA / JS-render caveat. If the page is JS-rendered (React, Vue, hydration), the static download may hold only a shell. The browser DOM is the truth. Capture `page.content()` after load and diff against the downloaded HTML. This is exactly why Step 2 and Step 3 are both required.
7. Network pass. Reload with the network log on. Catch web fonts (woff2), lazy-loaded images, CDN-hosted scripts, third-party trackers. Cross-reference with the asset list from Step 2.
8. Animation lib scan. If `--site-dir` is passed, grep the downloaded JS for GSAP, Lenis, framer-motion, AOS, scrollReveal, and IntersectionObserver usage. Writes `animation-libs.json`.

| Tier | Label | How it's captured | Fidelity | Caveat |
|------|-------|-------------------|----------|--------|
| Resolved | `authoritative` | CDP `Animation.getAnimationStyles` against the real running animation, including the CSS rules the engine matched | High | Only animations the browser has resolved. Elements that never start an animation are not here. |
| JS-inferred | `js-inferred` | Acorn AST scan directly on minified bundle (fallback when sourcemap fails) | Low-medium | Static analysis of minified code. Property names are usually not mangled but this is not guaranteed. Treat as educated guess. |
| Visual-only | `visual-only` | Canvas detection by **recorder**, not by probe | Reference only | No DOM/CSS representation exists to extract. Screenshot/video only for human reference, not reusable code. |

Canvas context types are **observed, never requested**. `installCanvasRecorder(page)`
wraps `HTMLCanvasElement.prototype.getContext` via `page.addInitScript` before the
first navigation and records which types the page itself asked for; `detectCanvas`
then only reads that record. Asking the canvas is the obvious way to find out and it
is destructive: `getContext` on a canvas that has none *creates* one and locks the
type, so a page whose own script calls `getContext` afterwards gets `null` and draws
nothing. When the recorder is absent, entries report `contextKnown: false` and an
empty `contexts` rather than a guess.

Motion results are written to `motion.json` and summarised in `manifest.json` under `motionCapture`. Four independent sources, because each one misses a class of motion the others catch:

```
motion.json
  sources.resolved    [...]  // CDP Animation.getAnimationStyles: what the engine
                            // resolved, with the CSS rules behind it
  sources.running     [...]  // document.getAnimations(), frame by frame
  sources.imperative  [...]  // inline-style churn from GSAP/anime/rAF, which never
                            // registers a WAAPI animation at all, plus text reveals
  sources.defined     [...]  // @keyframes rules, including inside @media/@supports

motion.json
  scroll            [{scrollY, entries: [{selector, transform, opacity, from, top}]}]
                     // measured BEFORE the screenshot scroll pass: scrolling for
                     // screenshots is what triggers a scroll-linked fade-in, so
                     // sampling afterwards finds them all already run
                     // an element needs a prior recorded value before it counts as
                     // a mover, and stop zero walks the WHOLE document so elements
                     // below the fold have that baseline
                     // start values are captured on transitionrun/animationstart,
                     // not during the walk: a 400ms transition is over by the time
                     // a full-document style walk reaches its target

manifest.json -> motionCapture
  mode: "quick" | "standard" | "full"
  path: "motion.json", sources: {...}, truncated: <bool>
  jsSourcemap: [...]     // from animations-js-sourcemap.json (--full only)
  jsInferred: [...]      // from animations-js-inferred.json (--full only, fallback)
  visualOnly: [...]      // canvas/WebGL detection results
```

An `imperative` track carries a `motion` field, and this is the part that decides how you rebuild it:

| `motion` | What moved | How to replay it |
|---|---|---|
| `style` | inline `transform` / `opacity` | tween the inline style; `stops[].inlineStyle` is the keyframe |
| `content` | the element's text, one chunk at a time | append characters on a timer; `stops[].text` is what was on screen at that offset |
| `mixed` | both | drive the style tween and the text append together |

The first stop of a track is its `baseline` — the state before anything moved. Keep it: it is what a replay resets to. A `content` track is seeded with the text as it was before the first character arrived, which is normally the empty string.

A `content` track is only created when the element grows its own children *and* its text, on separate ticks, at least three times. That threshold is deliberate: a single text change is a script tag or a chunk of markup arriving, and every ancestor of a revealing element sees its text change too. Without it every page reports hundreds of phantom tracks and the real one is lost in the noise.

Text reveals are also why the sampler is installed with `page.addInitScript` before the navigation rather than after the page settles. A typing effect that types out a line is finished before a post-load sampler ever sees the page, and it is simply absent from the capture with no indication it was ever there.

## 7. Step 4 — Merge into one reference doc

Write a single markdown file per site. Sections, in order:

```
# Reference: <site> by <owner>

1. DESIGN READ        one tagline: what the design actually is
2. DESIGN SYSTEM      tokens: live/tokens.json customProperties (named) + derived (cascade)
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
    tokens.json           customProperties (named) + derived (DTCG, whole cascade)
    dom.html              post-hydration DOM
    network.json          requests, fonts, lazy assets
    console.json          console messages and page errors
    interactions.json     click-pass results (one page load, reloaded on navigation)
    hover.json            hover pass results (transition timing + before/after)
    states.json           every pseudo-state, its measured timing, its changed props
    animation-libs.json   animation lib fingerprint scan (if --site-dir passed)
    motion.json            all motion: resolved (CDP), running, imperative, defined
    components.authoritative.json  framework-reported components (React/Vue/Next.js/Svelte); absent when none
    fidelity.json                 pixel score vs a reference dir; absent without --fidelity
    components.inferred.json  DOM clusters by shape signature, ranked by count
    unproducible.json      what this page cannot be rebuilt from, and why
    screenshots/unreproducible/  one cropped shot per unreproducible element
    targets.json           per-element capture for each --target selector
    targets/               one cropped screenshot per matched target
    tree/                  every captured file, paths rewritten, opens offline
    animations-js-sourcemap.json  JS animations from sourcemap (--full only)
    animations-js-inferred.json   JS animations from AST scan (--full only, fallback)
    capture.json          what the browser asked for, and what came back
    sourcemap-recovered/  original source tree recovered from sourcemaps (--full only)
    videos/scroll.webm    scroll pass recording (if --record-video passed)
    manifest.json         summary of all artifacts + motionCapture section, plus
                         partialFailures[] when an optional pass could not run
```

Three different things can be missing from a capture, and they are reported in
three different places. Check all three before telling anyone the clone is
complete:

- `capture.json.missing[]` — a response arrived and its body could not be taken.
  The reason is there (`body-too-large`, `store-full`, `body-unavailable`).
- `capture.json.uncaptured[]` — the browser issued the request and **no response
  ever arrived**. The page can be torn down mid-flight, or the capture stops with
  work still queued. Only this list sees that case: `missing[]` is empty
  precisely because no response was ever seen to fail.
- `manifest.json.partialFailures[]` — a pass that could not run at all
  (`{pass, error}`), listed only when something failed. The tree, the tokens and
  the DOM are on disk before the behaviour passes run, so a timeout on a heavy
  page records which pass gave up instead of discarding a capture that already
  succeeded.

An empty `uncaptured[]` with a non-empty `missing[]` means missing assets. A
non-empty `uncaptured[]` may mean whole chunks of a page are gone from a tree
that otherwise looks complete. A `partialFailures[]` means an artifact you were
about to read was never written, and the run exits `3` rather than `0` so a
chained `design-extractor <url> && next-step` stops instead of proceeding.

`tokens.json` groups custom properties by the type their **consumers** imply, not
by their names: `color`, `dimension`, `fontFamily`, `number`, `string`, each with
a DTCG `$type`, plus `_untypedAliases` for the aliases nothing consumes. An alias
used as a `color` is a colour whatever it is called; one nothing references is
counted, never filed under a guess from its name.

Read `unproducible.json` before promising a 1:1 rebuild. It names every canvas
surface and cross-origin stylesheet the capture hit, plus any truncated motion
sample and any component the framework confirmed but could not name. A rebuild
that skips those is not a 1:1 clone, and this file is where you say so before
you start rather than after. `complete: true` means the extractor looked and
found none of these — it is not a claim that the page is simple.

`unproducible.json.elements` is the per-element half of the honesty file: one
entry per element that cannot become DOM and CSS, each with `reason`
(`canvas2d` / `webgl` / `video` / `iframe` / `auth-gated` / `missing-asset`),
`selector`, `box` and the filename of a cropped screenshot of exactly that
region. Honour `--target` here too. The page-level `count` says something is
wrong; the element list says which things to go and look at.

`states.json` uses `mode` (not `method`) and `changed: {prop: {from, to}}` (not
`{prop: [before, after]}`) so it reads the same way as `targets.json`.
`timingSource` is the field to read before `timing`:

- `"measured"` — the duration came off a live running animation. Trust it.
- `"declared"` — nothing was running, so `timing` is the CSS
  `transition-duration`. That is a declaration, not an observation, and the
  entry carries a `note` saying so. Rebuilding the curve from it is a guess.
- `"unverified"` — no duration is claimed at all; a forced state that never
  animated.

`:checked` and `:disabled` are forced over CDP, and that is measured too, not
assumed: Blink animates a forced pseudo-class the same way it animates a real
one, so a checkbox whose `:checked` rule carries a 419ms transform comes back
`"measured"` with `419`. Forcing a state the element already has runs no
animation, so it comes back `"unverified"` instead of a number nobody watched
elapse.

Note the deliberate omission: there is no "drop the entry unless at least 3
properties changed" rule. A hover that changes one property is a real hover,
and dropping it would lose the transition most likely to be missed in a
rebuild.

`components.authoritative.json` and `components.inferred.json` never merge. The first is what
the framework reports; the second is what the DOM shape suggests. A cluster
carries `clusterId`, `signature`, `domTag`, `classList`, `count`,
`candidateLabels` and `sampleHtml` — and no field called `name`, because a guess
given a fact's field name is how a rebuild ends up confidently wrong.

The authoritative file still carries two kinds of entry, and the field that
tells them apart is `captureConfidence`. A production build renames every React
function component to one letter, so the framework happily reports a component
called `A` that is a real component boundary and a worthless identity. Those
entries stay in the file, flagged `"captureConfidence": "anonymous"`, with
`rawComponentName` next to them so a human can match them against the source.
**Filter on `captureConfidence === 'named'` before treating any
`componentName` as an identity.** On a production Vue or React build roughly
three quarters of the entries are anonymous; a rebuild that names files after
them inherits minifier output.

```js
const real = authoritative.components.filter((c) => c.captureConfidence === 'named');
```

`tokens.json` carries both signals on purpose: `customProperties` is what the
site named, `derived` is the DTCG set read off the whole cascade. A page that
names no tokens still has a cascade, and a page with 500 custom properties
usually has one scale hiding inside them.

`tokens.json.$extensions['design-extractor'].colorSchemes` is where the dark
theme lives. The typed groups hold the default scheme, so the diff lists only
what actually switches under `prefers-color-scheme`. Both schemes are read off
the live page via `emulateMedia`, and the page is put back before the next pass.

Two shapes of theme, two lists, and check both before concluding anything:

- `differs` / `values` — custom properties that switch. Use for shadcn-style
  palettes, where the theme is a redefinition of `--background` and friends.
- `elements` — sampled elements whose resolved style switches, each with the
  property and both values. Use for Tailwind-style sites, where not one custom
  property changes and the theme is plain `color` on the body.

`differs` empty does NOT mean the site has no dark theme. Check `elements` and
`counts.schemeElements` too; on `tailwindcss.com` `differs` is empty while
`elements` holds 91 rows. Either list empty is a result, not a gap. Do not infer
a theme from a token that is missing, and do not infer its absence from one list.

`motion.json.sources.scroll.sampled` is `false` when the scroll pass was
skipped, as `--quick` does. Read it before concluding from an empty `scroll`
array: without the pass there is no answer, rather than an empty one.

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

Requires Node 20+, Playwright Chromium.

---

## 11. Companion skill pointer

This skill is the intake for downstream design skills — `impeccable`, `design-taste-frontend`, `design-workflow`. It complements them by producing the faithful reference doc those skills consume; it does not replace them. Run this first to capture the source + motion truth, then hand the `reference.md` to the design workflow.
