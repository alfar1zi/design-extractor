# AGENTS.md

## Project

`design-extractor` is a Node.js ESM skill and CLI for capturing 1:1 design references from live websites. It downloads real source files (HTML/CSS/JS/images), drives a Playwright browser to record scroll, interactions, and breakpoints, and writes a single merged reference doc. Bins: `design-extractor`, `design-extractor-save`, `design-extractor-inspect`. Loads into Claude Code, OpenCode, Hermes, and Cursor via the `SKILL.md` frontmatter.

---

## Setup

```bash
node --version          # must be 20+
npm install
npm run install:browsers   # downloads Playwright Chromium
```

A one-shot installer also exists: `install.sh` (macOS/Linux) and `install.ps1` (Windows). Both are in the repo root.

---

## Code style

- ESM only (`"type": "module"`). No CommonJS.
- No classes. Plain functions and top-level `await` inside `async main()`.
- Hand-rolled arg parsing. No `commander`, no `yargs`.
- Native `fetch` (Node 20+). No `axios`, no `node-fetch`.
- Lazy-import heavy deps (`playwright`, `yauzl`) so unit tests can import pure helpers without the browsers installed.
- ANSI color only when `process.stdout.isTTY && !process.env.NO_COLOR`. No `chalk`.
- Shebang `#!/usr/bin/env node` on every CLI script.
- Entry guard: `if (import.meta.url === pathToFileURL(process.argv[1]).href) main()` so `node script.mjs` runs but `import './script.mjs'` does not.
- English comments. Concise. No AI-generated tells: no `data1`, `temp`, `result2`, no textbook narration.

---

## Testing

- Runner: `node --test scripts/__tests__/*.test.mjs`. No Jest, no Vitest.
- Pure helper functions must be `export`ed and covered by at least one assertion.
- Smoke tests only. No coverage threshold gating.
- Tests must run without network access: mock or use fixtures.
- 68 unit tests are currently passing across the 6 scripts.

---

## File layout

```
design-extractor/
  package.json          bins, deps, scripts
  README.md             quick start and reference for humans
  skills/design-extractor/SKILL.md   agent frontmatter and skill spec for runtimes
  AGENTS.md             this file, contributor conventions
  LICENSE               MIT
  install.sh            one-shot installer, macOS/Linux
  install.ps1           one-shot installer, Windows
  scripts/
    cli.mjs                 top-level orchestrator, flag parsing, child spawn
    inspect.mjs             Playwright runtime capture: tree, motion, tokens, components
    saveweb2zip.mjs         legacy third-party copier, opt-in only via --legacy-source
    capture-store.mjs       bounded response store, records every body it cannot take
    request-intercept.mjs   route interception; re-checks every redirect hop for SSRF
    url-safety.mjs          private/link-local address guard
    url-tree.mjs            URL -> collision-free path under the capture root
    rewrite.mjs             markup / CSS / JS reference rewriting
    tree-writer.mjs         writes the offline tree under the capture root
    cdp.mjs                 Chrome DevTools Protocol session and style helpers
    motion-sampler.mjs      MutationObserver style sampler; sees what getAnimations cannot
    motion-pass.mjs         merges every motion source into motion.json
    components.mjs          framework-reported and DOM-inferred components, kept separate
    tokens.mjs              DTCG tokens from resolved custom properties
    states.mjs              interaction-state style read/diff helpers
    unreproducible.mjs      names what this capture cannot rebuild, and why
    fidelity.mjs            image comparison for a rebuild
    record-pass.mjs        the one pass that watches a page during load
    target.mjs              --target resolution, crops and interaction states
    interaction-pass.mjs    click and hover screenshot pairs
    sourcemap-pass.mjs      source-map driven animation recovery (--full)
    __tests__/              unit tests, one file per script
```

Generated directories (`refs/`, `out/`, `.cache/`, `playwright-report/`, `node_modules/`) are gitignored. Do not commit them.

---

## When adding a script

- Add a bin entry under `package.json` `bin`.
- Export pure helpers (arg parser, URL parser, validators) so tests can import them without side effects.
- Write one smoke test in `scripts/__tests__/<name>.test.mjs`.
- Update README and `skills/design-extractor/SKILL.md` flag tables if the flags are user-facing.
- Keep the file under 400 lines. If it grows past that, split helpers into a sibling module.

---

## Commit message format

- Imperative, lowercase, no trailing period.
- Example: `port saveweb2zip to node esm`
- One logical change per commit.
- Use `git commit -s` only if your corporate workflow requires sign-off. No `Co-authored-by:` or `Generated with:` trailers.

---

## Pull request workflow

- Fork the repo, branch off `main`, run `npm test` before pushing.
- Open a PR with a description of what changed and why.
- Maintainer reviews and merges. No bot auto-merge.

---

## Out of scope

- Do not add new dependencies without justification in the PR description. Node 20+ stdlib covers most of what this skill needs; existing deps cover the rest.
- Do not add a build step. The CLI runs directly from source.
- Do not add a coverage threshold or CI runner unless the maintainer asks.
- Do not add more than one new `.md` file at the repo root without a clear reason. Each file needs an active maintainer to stay accurate.
