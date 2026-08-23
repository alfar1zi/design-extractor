# design-extractor

design-extractor is a portable agent skill -- capture faithful design references from any live website, with the actual source and the motion, not just screenshots.

[![node >=18](https://img.shields.io/badge/node-%E2%89%A518-339933)](.) [![license MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE) [![bin: design-extractor](https://img.shields.io/badge/bin-design--extractor-111)](.) [![maintainer](https://img.shields.io/badge/maintainer-1--person-lightgrey)](.)

[Install](#install) · [Usage](#usage) · [Output](#output) · [Pipeline](#pipeline) · [Setup](#setup) · [Roadmap](#roadmap)

---

## Why

Screenshot tools give you pixels. They miss source architecture, animation timing, runtime DOM, and interaction state -- the parts that determine how a design works.

design-extractor captures both signals: downloaded source files and a live Playwright browser pass. It merges them into one reference folder and one doc ready for a redesign build or taste-library intake.

## Demo

```bash
# npx design-extractor https://linear.app --out ./refs/linear
[cli] URL: https://linear.app
=== save ===
[save] Job: 9b68cd47f206d236b96898da9b7256fe_1787393091729
[save] status: copied=112 finished=true success=true
[save] OK: site_...zip (5860.0 KB)
[save] Extracted: 112 files -> ./refs/linear/site/site
=== inspect ===
[inspect] Viewport: 1440x900  timeout: 30s
[inspect] Scroll pass: 14 screenshots
[inspect] Interaction pass: 50 clickables (50 errored)
[inspect] Sweep pass: 2 viewports
[cli] source: 112 files  live: 124 files  total: 237 files
```

Three real production sites (2026-08-22, all numbers from `examples/*.log`):

| site | source files | live artifacts | total | zip size |
| --- | ---: | ---: | ---: | ---: |
| itomdev.com | 11 | 79 | 91 | 1451 KB |
| linear.app | 112 | 124 | 237 | 5860 KB |
| stripe.com | 288 | 130 | 419 | 61463 KB |

## Install

#### npm

```bash
npm install -g design-extractor
npm run install:browsers        # downloads Playwright Chromium
```

#### One-shot installer

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/alfar1zi/design-extractor/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/alfar1zi/design-extractor/main/install.ps1 | iex
```

#### From source

```bash
git clone https://github.com/alfar1zi/design-extractor.git
cd design-extractor
npm install
npm run install:browsers   # requires Node 18+
```

## Usage

**Step 1: one-shot orchestrator.**

```bash
npx design-extractor https://linear.app --out ./refs/linear
```

**Step 2: save and inspect separately.**

```bash
npx design-extractor-save https://linear.app --out ./refs/linear --rename-assets
npx design-extractor-inspect https://linear.app --out ./refs/linear/live --viewport 1440x900
```

Add `--record-video` to capture the scroll pass as `.webm`. Add `--site-dir` to scan JS for animation libs.

**Step 3: discover candidates.**

```bash
npx design-extractor-find --prompt "premium saas landing dark theme" --count 5
```

Drop template marketplaces and aggregators. Pick one URL, then run Step 1.

## Pipeline

| Stage | What it does | Output artifact |
| --- | --- | --- |
| Find | Query the web for candidate URLs matching a design prompt | list of URLs to stdout |
| Save | Download full site via saveweb2zip: HTML, CSS, JS, images, fonts | `site/` folder |
| Inspect | Drive Playwright: scroll, interactions, viewport sweep, token dump | `live/` folder |
| Merge | Write one reference doc: tokens, components, layout, animations, assets | `REFERENCE.md` |

Skip Find if you have a URL. Skip Save if you only need live screenshots.

## Output

After a full run on `https://target.example --out ./refs/target`:

```
refs/target/
  site/               downloaded source: HTML, CSS, JS, images, fonts
  live/
    screenshots/      full.png, scroll-01..N.png, tablet.png, mobile.png
    a11y-tree.json    full accessibility tree
    tokens.json       resolved CSS custom properties (getComputedStyle)
    dom.html          post-hydration DOM
    network.json      requests, fonts, lazy assets
    interactions.json click-pass results
    animation-libs.json  library fingerprint (if --site-dir passed)
    manifest.json     artifact index
  REFERENCE.md        merged reference: tokens, components, layout, animations, assets
```

The folder is the artifact. Hand it to a redesign build or taste-library intake as-is.

## Setup

Point your agent runtime at `SKILL.md`. The frontmatter `name` and `description` register the trigger phrases.

#### Claude Code

```bash
ln -s /path/to/design-extractor/SKILL.md .claude/skills/design-extractor.md
```

Triggers on phrases like "extract design from" or "capture reference from".

#### OpenCode

```bash
ln -s /path/to/design-extractor/SKILL.md ~/.config/opencode/skills/design-extractor.md
```

#### Hermes

```json
{ "path": "/path/to/design-extractor/SKILL.md" }
```

#### Cursor

Add `SKILL.md` to `.cursor/rules` or your project context file.

## Companion skills

- **impeccable** -- audits a built UI against the reference; catches color drift, spacing violations, missing motion.
- **design-taste-frontend** -- ingests the reference folder and applies tasted style decisions to a new build.
- **design-workflow** -- coordinates the full redesign cycle; uses the reference as the intake for planning.

## Roadmap

| # | capability | status |
| --- | --- | --- |
| 1 | Site download via saveweb2zip | [x] |
| 2 | Full-page and viewport screenshots | [x] |
| 3 | Scroll-through screenshot pass | [x] |
| 4 | Tablet and mobile viewport sweep | [x] |
| 5 | Accessibility tree dump | [x] |
| 6 | Post-hydration DOM capture | [x] |
| 7 | Resolved CSS token dump (getComputedStyle) | [x] |
| 8 | Network request log | [x] |
| 9 | Animation library fingerprint scan (--site-dir) | [x] |
| 10 | Scroll pass video recording (--record-video) | [x] |
| 11 | REFERENCE.md stub generation | [x] |
| 12 | Interaction click pass (before/after diff) | [ ] fix tracked, v0.2 |
| 13 | Video-to-gif conversion for REFERENCE.md embeds | [ ] |
| 14 | Interaction-state diff visualization | [ ] |
| 15 | Design token diff between two captured sites | [ ] |
| 16 | Multi-page capture workflow (follow internal links) | [ ] |

The interaction pass errored on all elements in v0.1 (fragile locator synthesis on shadow DOM). Fix tracked in `scripts/inspect.mjs`.

## Contributing

Read `AGENTS.md` for code style, testing, file layout, commit format, and PR workflow. License: MIT. Maintainer: alfar1zi.
