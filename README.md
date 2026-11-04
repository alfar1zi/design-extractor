<p align="center">
  <img src="assets/logo.svg" width="128" alt="design-extractor logo">
</p>
<h1 align="center">design-extractor</h1>
<p align="center">Capture a website's source, runtime behavior, and design tokens into an offline reference an agent can rebuild.</p>
<p align="center">
  <a href="https://github.com/alfar1zi/design-extractor/actions/workflows/ci.yml"><img src="https://github.com/alfar1zi/design-extractor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933.svg" alt="node 20 or newer">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

<p align="center"><img src="assets/proof-offline-replay.png" width="848" alt="Live and offline replay screenshots with capture and replay metrics"></p>

The proof capture is `teenage.engineering` at `1440x900`: 86 files / 4.0 MB,
0 missing, 0 blocked. Live: 1285 elements and 5/13 images. Replay: 733 elements,
4/12 images, 1 external request blocked (`cdn.fonts.net`), and 0 local misses.
The live and replay viewports have 0 changed pixels (`0.0000%`, same MD5).

## Workflow

| Step | Command | Result |
| --- | --- | --- |
| Capture | `node scripts/cli.mjs <url> --out ./refs/name` | Browser capture and offline tree |
| Inspect | `node scripts/inspect.mjs --url <url> --out ./refs/name/live` | Runtime evidence and design tokens |
| Read | Give `./refs/name` to your agent | Source, screenshots, and JSON artifacts |

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/pipeline-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/pipeline.svg">
    <img src="assets/pipeline.svg" width="848" alt="Pipeline from URL to reference folder and fidelity score">
  </picture>
</p>

The default pipeline runs the local browser capture. `--legacy-source` is opt-in and
POSTs the URL to the third-party `copier.saveweb2zip.com`. MCP is not shipped:
long browser captures and folder artifacts do not fit a useful stateless contract.

## Output

| Path | Contents |
| --- | --- |
| `live/tree/` | Rewritten tree that opens offline |
| `live/screenshots/` | Full-page, scroll, tablet, and mobile captures |
| `live/dom.html` | Post-hydration DOM |
| `live/tokens.json` | Named and resolved CSS tokens plus color schemes |
| `live/motion.json` | Observed and declared motion tracks |
| `live/interactions.json` | Click results and navigation observations |
| `live/hover.json`, `live/states.json` | Hover and pseudo-state evidence |
| `live/a11y-tree.json` | Accessibility tree |
| `live/network.json`, `live/manifest.json` | Requests and artifact index |
| `live/unproducible.json` | Canvas, video, missing asset, and other limits |

## Install

**Agent skill**

```bash
npx skills add alfar1zi/design-extractor
```

**Claude Code plugin**

```text
/plugin marketplace add alfar1zi/design-extractor
/plugin install design-extractor@design-extractor
```

**CLI from a clone**

```bash
git clone https://github.com/alfar1zi/design-extractor.git
cd design-extractor
npm install
npm run install:browsers
node scripts/cli.mjs https://example.com --out ./refs/example
```

The CLI is available from a clone today. `npx design-extractor` will work after the package is published with `npm publish`.

## Usage

```bash
node scripts/cli.mjs https://example.com --out ./refs/example --quick
node scripts/cli.mjs https://example.com --out ./refs/example --full
node scripts/cli.mjs https://example.com --target ".hero" --out ./refs/example
node scripts/cli.mjs https://example.com --out ./refs/rebuild --fidelity ./refs/example/live/screenshots
```

Useful flags include `--viewport 1440x900`, `--timeout 30`, `--no-scroll`,
`--no-interactions`, `--no-sweep`, `--no-states`, `--sourcemap`, `--allow-private`,
and repeatable `--target <css>`.

## Limits

| Captured | Boundary |
| --- | --- |
| HTML, CSS, JS, images, fonts | Source download is third-party and opt-in |
| DOM, accessibility tree, tokens | Post-hydration state only |
| Clicks, hovers, pseudo-states | SPA hydration and shadow widgets can remain unobserved |
| Scroll screenshots and motion | Scroll-linked motion is sampled at discrete positions |
| Canvas, WebGL, video, auth-gated regions | Named in `unproducible.json`, not reconstructed as DOM/CSS |
| Fidelity score | Same browser, viewport, and device scale factor are required |

## Links

| Resource | Path |
| --- | --- |
| Agent skill | [`skills/design-extractor/SKILL.md`](skills/design-extractor/SKILL.md) |
| Security policy | [`SECURITY.md`](SECURITY.md) |
| License | [`LICENSE`](LICENSE) |

Contributor convention: run `node --test` or `npm test`, `npm run lint`, and
`npm run validate` before submitting. Use ESM, and add no dependency without a reason.
