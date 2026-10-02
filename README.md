<p align="center">
  <img src="assets/logo.png" width="220" alt="design-extractor logo">
</p>

<h1 align="center">design-extractor</h1>

<p align="center">
  Stop copying pixels. Screenshots miss the motion. Extract the actual source, computed tokens, and runtime behavior.
</p>

<p align="center">
  <a href="../../actions/workflows/ci.yml"><img src="../../actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="."><img src="https://img.shields.io/badge/node-%E2%89%A520-339933" alt="node >=20"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license MIT"></a>
  <a href="."><img src="https://img.shields.io/badge/slash--command-%2Fdesign--extractor-7170ff" alt="slash command: /design-extractor"></a>
</p>

---

## Why

Screenshot tools give you pixels. They miss source architecture, animation timing, runtime DOM, and interaction state. These parts determine how a design works.

design-extractor captures both signals: downloaded source files and a live Playwright browser pass. It merges them into one reference folder and one doc ready for a redesign build or taste-library intake.

## Setup

#### Claude Code

Run inside your workspace to install:
```bash
/plugin marketplace add alfar1zi/design-extractor
/plugin install design-extractor@design-extractor
```
Now trigger via `/design-extractor <url>`.

#### OpenCode

Add the plugin entry to `~/.config/opencode/plugins.json` pointing to this repository. Trigger via `/design-extractor <url>`.

#### Hermes

Run the installation script `install.sh`. The command is registered globally to the Hermes shell.

#### Cursor

Add the path to `skills/design-extractor/SKILL.md` to your Cursor Rules (`.cursorrules`). The agent reads it on demand when design tasks are requested.

## Pipeline

| Slash Command | What it does | Output artifact |
| --- | --- | --- |
| /design-extractor-save | Download full site via saveweb2zip: HTML, CSS, JS, images, fonts | `site/` folder |
| /design-extractor-inspect | Drive Playwright: scroll, interactions, viewport sweep, token dump | `live/` folder |
| /design-extractor | Run the full extraction pipeline | `site/` + `live/` |

Skip `/design-extractor-save` if you only need browser-captured artifacts; it is off by default because it POSTs the target URL to a third-party copier.

**SSRF Protection**: All entry points run a safety check to block local/private IP ranges. Pass `--allow-private` to permit loopback or private targets. Note that `assertSafeUrl` validates at check time only, so DNS rebinding between check and connect is theoretically possible. Pair with egress policy for high-trust environments.

Once installed, trigger the capture directly inside your agent chat:
```bash
/design-extractor https://linear.app --out ./refs/linear
```

<details>
<summary>CLI Fallbacks (local)</summary>

Save and inspect separately (Note: Not yet published to npm. Run from clone with `node scripts/<name>.mjs`):
```bash
node scripts/saveweb2zip.mjs --url https://linear.app --out ./refs/linear --rename-assets
node scripts/inspect.mjs --url https://linear.app --out ./refs/linear/live --viewport 1440x900
```

Add `--record-video` to capture the scroll pass as `.webm`. Add `--site-dir` to scan JS for animation libs. Add `--sourcemap` to recover original function names from JS source maps. Add `--fidelity <dir>` to score a finished replica directory against the original — see `fidelity.json`.

**Exit codes** (from `design-extractor` / `scripts/cli.mjs`):

| Code | Meaning | Artifacts |
| --- | --- | --- |
| `0` | every pass ran | complete |
| `3` | captured, but a pass failed — see `manifest.json` `partialFailures[]` | usable, incomplete |
| `2` | bad usage, or the URL resolves to a private/loopback address | none |
| `1` | hard failure; the capture did not finish | none |

`3` exists so a caller can tell "this site is fine but the states pass broke" from
"this run worked", without scraping stdout. The tree on disk is real in both the
`3` and `0` cases.

To clone one element instead of the whole page, pass `--target` as many times as
you like. Each match is captured on its own: its markup, its computed styles,
its hover and focus states with the measured transition, and a screenshot
cropped to it. A selector that matches nothing is reported in `targets.json`
rather than throwing, so one stale selector does not lose the rest — but a run in
which *every* selector misses is almost always a typo, and it fails instead of
filling the output directory with artifacts scoped to nothing.

`--target` scopes the analysis too, not just the screenshots. `motion.json`,
`components.authoritative.json`, `components.inferred.json` and `tokens.json` then describe
only what is inside the matched subtrees, and each of them records the `scope`
it was captured under. `tokens.json` gains `scopedProperties`: the custom
properties actually in force on those elements, which is not the same set as
the ones the site declares in its stylesheets — a component that overrides an
inherited token only shows up here.

The capture tree, the accessibility tree and the screenshots stay whole. A tree
filtered to a subtree cannot render, because it loses the ancestor chain that
positions it.

```bash
node scripts/inspect.mjs --url https://linear.app --out ./refs/linear/live \
  --target ".pricing-card" --target "nav[aria-label=primary]"
```

**Backend recommendation**: set `BRAVE_API_KEY` and use `--backend brave` (or `--backend auto` with the key set). The DuckDuckGo backend scrapes HTML without an API key but is fragile (markup changes break the parser; we now throw a distinct "DuckDuckGo HTML markup changed; parser needs update" error so you can tell parser miss apart from a genuine zero-result query) and brittle (ToS gray area, easy rate-limit). Brave is the recommended path for production use.

Drop template marketplaces and aggregators. Pick one URL, then run the capture.
</details>

## Demo

```bash
# design-extractor https://tailwindcss.com --out ./refs/tw
[cli] URL: https://tailwindcss.com
[cli] OutDir: ./refs/tw
=== inspect ===
[inspect] Tokens: 491 custom properties, 719 from the cascade
[inspect] Capture: 71 files, 10340KB, 0 missing, 0 blocked redirects
[inspect] Hover pass: 20 hovers (3 errored)
[inspect] Motion: 5 @keyframes, 1 running, 4 imperative, 1 resolved, truncated
[inspect] Components: 10 named, 3080 minified, 88 inferred clusters
[inspect] 2 things on this page cannot be reproduced from the capture
[inspect] OK: ./refs/tw/live (14 artifacts)
[cli] data:  a11y-interactive.json  a11y-tree.json  capture.json  components.inferred.json
         components.authoritative.json  console.json  fidelity.json  hover.json  motion.json  network.json  tokens.json
         unproducible.json
```

`--fidelity <dir>` scores the capture's own screenshots against a reference
directory of the same shots and writes `fidelity.json`: a `diffRatio` per
viewport, the largest box where the two disagree, and the regions that were
never reproduced. Both sides have to come from one Chromium at one viewport with
`deviceScaleFactor 1` — Playwright documents that rendering varies by host OS and
browser build, so a diff taken under different conditions measures the
environment rather than the rebuild.

```bash
node scripts/cli.mjs https://example.com/ --out rebuild --fidelity ref/live/screenshots
```

Without the flag, use the module directly. Every name present on one side only
is reported rather than skipped, so a rebuild that dropped half its screenshots
cannot score as a clean run:

```bash
node -e "import('./scripts/fidelity.mjs').then(async m => {
  const r = await m.compareDirectories('ref_example/live/screenshots', 'rebuild/screenshots');
  console.log(r.overall, r.counts, r.worst);
})"
```

`compareImages` reports `diffRatio` itself. `looks-same` leaves `differentPixels`
and `totalPixels` `undefined` on an exact match, which read as a broken capture
rather than a perfect one.

Measured on real captures (2026-10-01): replaying a captured `example.com` from
disk with the network closed reproduced the page at **0.0000%** differing pixels
and 0 clusters. Replaying `gsap.com` the same way came out at **2.32%** across 11
clusters — and the tool had already named why, listing six `<video>` regions and
three auth-gated ones in `unreproducible.json` before anyone compared a pixel.

Three real production sites (2026-08-22, all numbers from `examples/*.log`):

| site | source files | live artifacts | total | zip size |
| --- | ---: | ---: | ---: | ---: |
| itomdev.com | 11 | 79 | 91 | 1451 KB |
| linear.app | 112 | 124 | 237 | 5860 KB |
| stripe.com | 288 | 130 | 419 | 61463 KB |

## Output

After a full run on `https://target.example --out ./refs/target`:

```
refs/target/
  site/               downloaded source: HTML, CSS, JS, images, fonts
  live/
    tree/             every captured file; cross-origin refs rewritten to tree paths, opens offline
    screenshots/      full.png, scroll-01..N.png, tablet.png, mobile.png
    targets/          one cropped screenshot per --target selector
    a11y-tree.json    full accessibility tree
    tokens.json       custom properties the site named + DTCG tokens from the whole cascade
    dom.html          post-hydration DOM
    network.json      requests, fonts, lazy assets
    interactions.json click-pass results
    hover.json        per-element hover state, with the measured transition
    states.json       every pseudo-state on the page, with its measured timing
    motion.json       animation tracks, plus what scrolling revealed
    components.authoritative.json  framework-reported components (React/Vue/Next.js/Svelte); absent when none
fidelity.json               pixel score against a reference dir; written only with --fidelity
    components.inferred.json  DOM clusters, kept separate from the above
    unproducible.json what this page cannot be rebuilt from, and why
    screenshots/unreproducible/  one cropped shot per unreproducible element
    animation-libs.json  library fingerprint (if --site-dir passed)
    manifest.json     artifact index
```

`components.authoritative.json` and `components.inferred.json` are separate on purpose. The
first is what the framework says; the second is what the DOM shape suggests. A
guess given the same field name as a fact is how a rebuild ends up confidently
wrong.

The authoritative file holds two kinds of entry, separated by `captureConfidence`.
A production build renames every React function component to a single letter, so
the framework reports a real component boundary whose name carries no
information. Those entries stay, flagged `"anonymous"`, alongside the
untruncated `rawComponentName`. Filter on `captureConfidence === 'named'` before
using any `componentName` as an identity — on production Vue and React sites
most entries are anonymous, and a rebuild that names files after them inherits
minifier output.

`capture.json` is the completeness file, and it separates two failures that look
identical from the outside:

- `missing[]` — a response arrived and its body could not be taken. The reason
  is there (`body-too-large`, `store-full`, read failure).
- `uncaptured[]` — the browser issued the request and **no response ever
  arrived**. A page can be torn down mid-flight, or the capture can stop with
  work still queued. Nothing but this list can see that case: `missing[]` is
  empty precisely because no response was ever seen to fail.

A capture with an empty `uncaptured[]` and a non-empty `missing[]` is missing
assets. A capture with a non-empty `uncaptured[]` may be missing whole chunks of
a page the tree otherwise looks complete for. Check it before trusting the tree.

`manifest.json.partialFailures[]` is a third, unrelated thing: a pass that could
not run (`{pass, error}`). The run then exits `3`, not `0`, so a script that
chains `design-extractor <url> && next-step` stops instead of consuming a
directory whose `states.json` was never written.

`unproducible.json` is the honesty file. Canvas and WebGL surfaces,
cross-origin stylesheets, truncated motion sampling and components the framework
confirmed but could not name are listed with counts, so a capture that silently
dropped part of the page reads as incomplete instead of finished. `complete:
true` means those checks ran and found nothing — not that the page is simple.

`unproducible.json` also carries `elements`: one entry per element that cannot be
turned into DOM and CSS, each with the reason, the box it occupies, and the name
of a cropped screenshot of exactly that region in
`screenshots/unreproducible/`. The reasons are `canvas2d`, `webgl`, `video`,
`iframe`, `auth-gated` and `missing-asset`. A page-level count tells you
something is wrong; thirty canvases with a photo each tell you which thirty to
go and look at.

`states.json` lists every pseudo-state found, each with `mode` and a `changed`
map of `{property: {from, to}}`. `timingSource` is the field to read first:
`'measured'` means the duration was read off a live running animation,
`'declared'` means nothing was running and the number is the CSS
`transition-duration` — a declaration, not an observation — and `'unverified'`
means no duration is claimed at all. A `'declared'` entry also carries a `note`
saying so. Rebuilding a curve from a `'declared'` value is a guess; from a
`'measured'` one it is not.

Forced states are measured, not assumed. `:checked` and `:disabled` have no
cursor-driven equivalent, so they are forced over CDP with
`CSS.forcePseudoState`. That works because Blink animates a forced
pseudo-class the same way it animates a real one: on a checkbox whose
`:checked` rule carries a 419ms transform, the forced state reports
`timingSource: 'measured'` with `timing: 419` — the duration of the running
animation, not the declaration re-read. Forcing a state the element already
has changes nothing, runs no animation, and correctly reports `'unverified'`
rather than quoting a number nobody observed.

`motion.json.scroll` holds what was measured while scrolling — elements whose
style changed between one scroll position and the next, with the value they
started from and ended at. A fade-in that only ever runs once, when it scrolls
into view, appears nowhere else.

`sources.scroll.sampled` says whether the scroll pass ran at all. A `--quick`
run turns it off, and without that flag an empty `scroll` array would read as
"this page has no scroll-linked motion" when the truth is "nobody looked".

`tokens.json` holds two things on purpose: `customProperties` is intent (the
site named these), `derived` is evidence (these are the values the cascade
actually uses). Plenty of sites name nothing at all.

`tokens.json.$extensions['design-extractor'].colorSchemes` carries the theme.
The typed groups at the top level hold the default scheme. Both are captured by
re-reading the page under `page.emulateMedia({colorScheme})`, then restoring
what the host prefers.

- `differs` names the custom properties that switch, `values` holds each one's
  value in the scheme that differs. This is the shadcn shape, where the theme is
  a redefinition of `--background` and friends.
- `elements` names the sampled elements whose resolved style switches, each with
  the property and both values. This is the Tailwind shape, where not one
  custom property changes and the theme is plain `color` on the body. Without
  it a capture reports "no theme" for a site that visibly has one — measured on
  `tailwindcss.com`, where `differs` was empty and `elements` found 91.

The element sample is bounded at 150 visible elements in document order across 7
theme-relevant properties, because a whole-tree walk is a page-sized cost for an
answer that a consumer uses to find the few places a rebuild must handle.
`counts.schemeElements` reports how many rows `elements` actually holds. Empty is
a result on either list, not a gap.

The folder is the artifact. Hand it to a redesign build or taste-library intake as-is.

## What has been measured, and what has not

Everything above is a description of the format. This is the part where the tool
could be wrong about itself, so it is written as numbers and as a list of things
still unproven.

**A fully DOM-representable site replays at `diffRatio: 0`.** The capture of the
test fixture, replayed offline from its own tree with the network switched off,
produces a byte-identical PNG — same 159,746 bytes, `status: identical`. That is
the number a rebuild should be measured against; anything above zero is the
rebuild's, not the capture's. The comparison is proven to read pixels rather than
return zero by default: perturbing a single token in the replica
(`--radius: 0.5rem` → `24px`) moves the ratio to `0.0006` across 30 clusters.
Both sides are shot in one browser at one viewport and one device scale factor,
because rendering varies by browser and headless mode and a cross-browser diff
measures the browsers.

**Closed shadow roots are readable.** `DOM.getDocument({depth: -1, pierce: true})`
crosses a `mode: 'closed'` shadow root in Chromium, and returns the text inside
it. The same root is invisible to page JavaScript — `element.shadowRoot` is
`null` and `textContent` is empty — so this is the debugger's privilege, not a
trick, and content behind a closed root reaches the capture. Measured rather
than assumed: the build plan stated this without ever running it, and the first
two probes to test it were themselves wrong — one read a field the protocol does
not return, and the next walked the tree but had no case that had to succeed, so
a null result looked like a fact.

**A forced pseudo-state is measured, not assumed.** `:checked` and `:disabled`
have no cursor-driven equivalent, so they are forced over CDP with
`CSS.forcePseudoState`. The belief that Blink animates a forced pseudo-class the
way it animates a real one is now verified rather than asserted: on a checkbox
whose `:checked` rule carries `transform 419ms`, the forced state comes back
`timingSource: 'measured'`, `timing: 419` — the longest of the two transitions
on the element, not the declaration re-read and not a default. Forcing a state
the element already has changes nothing, starts no animation, and comes back
`'unverified'` rather than quoting a number nobody watched elapse. Both halves
are asserted in `scripts/__tests__/states-pass.test.mjs`, the second being the
negative control that would catch a fabricated duration.

**The motion sampler does not touch the page it measures.** It is installed
before navigation and watches with a `MutationObserver` and a rAF loop from
load onward, so the natural worry is that observing perturbs the thing being
observed — the observer running on the same frames as the animation could change
what gets animated. Measured: on a page with nothing moving, the document HTML,
every element's computed style, and the full-page screenshot are all identical
with the sampler installed and without it, and the two PNGs are byte-identical.
The page has to be still for that to mean anything; on an animating page any
difference could be the animation rather than the observer. The sampler writes
nothing to the DOM, and the test is there to keep it that way.

**Colour schemes are read off the live page, not inferred from the stylesheet.**
`prefers-color-scheme` is emulated and the page re-read, so a token that
switches is reported with the value it actually becomes. A token that holds its
value across both schemes is not listed: on the test fixture only the surface
colours move, and reporting the spacing scale as a theme token would be worse
than reporting nothing.

**A theme is found even when no token changes.** This one was measured against
the tool rather than assumed, and it caught a false negative. `tailwindcss.com`
was first captured as having no dark theme at all — `differs` was empty. That
was wrong. Probing the same page by hand showed `emulateMedia` reaching it
perfectly well and `body`'s `color` flipping `rgb(0, 0, 0)` → `rgb(255, 255, 255)`;
the site expresses its theme in plain properties, so a tool that only compares
custom properties sees nothing. Comparing resolved style on a bounded element
sample found 91 changing elements on the same page. The lesson is the one the
rest of this section keeps making: a number reading "none" is only evidence of
absence once the thing that could have produced it has been shown to work.

Not proven, and treated as unknown rather than assumed to work:

- **Scroll-linked motion is sampled at discrete positions, not continuously.** A
  scrubbed animation between two sampled scroll offsets is reconstructed from
  two points.
- **`@keyframes` in a bundled stylesheet that the engine never instantiated is
  reported as declared, not measured.** Read `timingSource` before trusting a
  duration.
- **A WebGL hero or a video is listed in `unproducible.json` and cannot be
  rebuilt from a capture.** The pixels are not recoverable; a video is not a
  still image. `fidelity.json` carries those findings per viewport so a low
  ratio is not read as a match.
- **Fidelity is one browser, one machine.** A score of 0 here is not a promise
  about Safari or a different display scale.

## Companion skills

- **impeccable**: audits a built UI against the reference; catches color drift, spacing violations, missing motion.
- **design-taste-frontend**: ingests the reference folder and applies tasted style decisions to a new build.
- **design-workflow**: coordinates the full redesign cycle; uses the reference as the intake for planning.

## Contributing

Read `AGENTS.md` for code style, testing, file layout, commit format, and PR workflow. License: MIT. Maintainer: alfar1zi.
