# AGENTS.md

## Project

`design-extractor` is a portable agent skill (Node.js ESM) that captures a 1:1 design reference from a live website: downloads real source (HTML/CSS/JS/images), deep-reads the design system, drives a real browser to record motion/interactions/breakpoints, and writes a single reference doc. It exists because screenshot-only references miss source architecture, animation, and runtime DOM. Loads into any agent runtime that reads `SKILL.md` frontmatter (Claude Code, OpenCode, Hermes, Cursor, etc.). Bins: `design-extractor`, `design-extractor-save`, `design-extractor-find`, `design-extractor-inspect`.

## Hard rules

1. **No AI in git history. Ever.** No agent (Claude, OpenCode, Hermes, Cursor, GPT, Copilot, or any other) may commit, push, or appear as git author or co-author. Only the human owner: `alfar1zi <f.alfarizii10@gmail.com>`. `git log` must be 100% human. No `Co-authored-by: <AI> <...>` trailers in commit messages. If an AI tool auto-adds a trailer, strip it before committing.
2. **No em dash** (`U+2014`) anywhere. Code, comments, docs, commit messages. Use ` - `, `--`, or rewrite the sentence.
3. **No emoji** as UI icons, in code comments, or in commit messages. ASCII (`->`, `*`, `>`) is fine.
4. **No new dependencies without justification.** PR description must state why the dep is needed and why a Node 18+ stdlib feature or existing dep can't cover it. Maintainer approval required. Bias toward stdlib.
5. **Never commit generated artifacts.** `refs/`, `out/`, `.cache/`, `playwright-report/`, `test-results/`, `node_modules/`, `dist/`, `*.log`. They are gitignored; treat the rule as belt-and-suspenders.
6. **Never commit secrets.** No `.env`, API keys, session tokens, `.npmrc` auth. Use env vars at runtime.
7. **Max 6 .md files at root** (README, SKILL, AGENTS, LICENSE, CONTRIBUTING, and at most one more). Justify any addition in the PR. Expect pushback.
8. **Keep scripts under 400 lines.** Pure helpers must be exported for tests.

## Commands

```bash
# setup (once)
npm install
npm run install:browsers          # downloads Playwright chromium

# run
npx design-extractor-find --prompt "premium saas landing dark" --count 5
npx design-extractor-save --url https://target.example --out ./refs/target
npx design-extractor-inspect --url https://target.example --out ./refs/target/live --viewport 1440x900
npx design-extractor <url>        # top-level orchestrator (calls find + save + inspect + merge)

# test
npm test                          # runs node --test scripts/__tests__/*.test.mjs
```

## Code style

- ESM only (`"type": "module"`). No CommonJS.
- No classes. Plain functions + top-level `await` inside `async main()`.
- Hand-rolled arg parsing. No `commander`/`yargs`.
- Native `fetch` (Node 18+). No `axios`, no `node-fetch`.
- Lazy-import heavy deps (`playwright`, `yauzl`) so unit tests can import pure helpers without `npm install`.
- ANSI color only when `process.stdout.isTTY && !process.env.NO_COLOR`. No `chalk`.
- Shebang `#!/usr/bin/env node` on every CLI script.
- Entry guard: `if (import.meta.url === pathToFileURL(process.argv[1]).href) main()` so `node script.mjs` runs but `import './script.mjs'` does not.
- English comments. No fluff comments. No "AI-generated" tells (no `data1`/`temp`/`result2`, no textbook narration).

## Testing

- Runner: `node --test scripts/__tests__/*.test.mjs`. No Jest, no Vitest.
- Pure helper functions must be `export`ed and covered by at least one assertion.
- Smoke tests only. No coverage threshold gating. This is a small skill, not a SaaS.
- Tests must run without network access (mock or use fixtures).

## File layout

```
design-extractor/
  package.json              bins, deps, scripts (source)
  README.md                 quick start (source, tracked)
  SKILL.md                  agent frontmatter + skill spec (source, tracked)
  AGENTS.md                 this file (source, tracked)
  LICENSE                   MIT (source, tracked)
  scripts/                  source
    cli.mjs                 top-level orchestrator
    saveweb2zip.mjs         download via saveweb2zip API
    find-refs.mjs           discover candidate URLs
    inspect.mjs             Playwright runtime capture
    __tests__/              unit tests (source)
  node_modules/             ignored
  refs/ out/ .cache/        generated per run, ignored
  playwright-report/        Playwright HTML report, ignored
  notes/ working/ sessions/ drafts/   internal working notes, ignored
  .claude/ .opencode/ .cursor/        agent runtime state, ignored
```

## When adding a script

- Add the bin entry to `package.json` under `bin`.
- Export pure helpers (arg parser, URL parser, validators) so tests can hit them.
- Write one smoke test in `scripts/__tests__/<name>.test.mjs`.
- Update `SKILL.md` flag table if flags are user-facing.
- Keep the file under 400 lines. If a script grows past that, split it.

## Commit message format

- Imperative, lowercase, no period, no trailers.
- Example: `port saveweb2zip to node esm`
- No `Co-authored-by:` lines. No `Signed-off-by:` unless the maintainer adds it manually. No `Generated with:` footers.
- One logical change per commit.
