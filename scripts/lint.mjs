#!/usr/bin/env node
// lint.mjs - repository invariants that a unit test cannot state.
//
// Two classes of defect kept appearing in this repository and neither shows up in
// a test run: a flag documented in README.md or SKILL.md that no parser accepts,
// and a file added at the root that a reader has to decide whether to open.
// Both are checkable from the tree, so they are checked here.
//
// Run: npm run lint

import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The root is a landing page, not a filing cabinet. Each extra .md there is one
// more thing a visitor has to triage before they can install anything.
const ROOT_MARKDOWN = ['README.md'];

// Flags that belong to another tool and are documented as such. Every entry earns
// its place: npm's own, git's, and the browser install the README quotes.
const EXTERNAL_FLAGS = new Set(['--with-deps', '--yes', '--no-audit', '--no-fund', '--ignore-scripts', '--dry-run']);

const CLI_SOURCES = ['scripts/cli.mjs', 'scripts/inspect.mjs', 'scripts/saveweb2zip.mjs'];

/** Every `--flag` a CLI accepts, from its parseArgs switch labels. */
async function acceptedFlags() {
  const flags = new Set();
  for (const rel of CLI_SOURCES) {
    const src = await readFile(join(REPO, rel), 'utf8');
    for (const m of src.matchAll(/\bcase\s+'(--[a-z0-9-]+)'/g)) flags.add(m[1]);
  }
  return flags;
}

/**
 * Flags named on a line that runs a command.
 *
 * Scoping to those lines is what keeps this usable: `--radius` in a token table
 * and `--background` inside `var(...)` are CSS custom properties, not CLI flags,
 * and a rule that cannot tell them apart reports them and gets switched off.
 */
export function flagsOnCommandLines(text) {
  const found = [];
  for (const line of text.split('\n')) {
    if (!/(?:design-extractor|node\s+scripts\/|npx\s|\/design-extractor|^!\s*node)/.test(line)) continue;
    for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)(?![\w*-])/g)) found.push(m[1]);
  }
  return found;
}

/** Every `--flag` the prose tells a reader to use. */
async function documentedFlags() {
  const files = ['README.md'];
  for (const dir of ['skills', 'commands']) {
    for (const e of await readdir(join(REPO, dir), { withFileTypes: true })) {
      if (e.isDirectory()) {
        for (const f of await readdir(join(REPO, dir, e.name))) {
          if (f.endsWith('.md')) files.push(join(dir, e.name, f));
        }
      } else if (e.name.endsWith('.md')) {
        files.push(join(dir, e.name));
      }
    }
  }
  const found = new Map();
  for (const rel of files) {
    const text = await readFile(join(REPO, rel), 'utf8');
    for (const flag of flagsOnCommandLines(text)) {
      if (!found.has(flag)) found.set(flag, rel);
    }
  }
  return found;
}

async function mjsFiles(dir = REPO, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await mjsFiles(full, out);
    } else if (e.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  const problems = [];

  // 1. Every module parses. A syntax error in a module no test imports is
  //    invisible to `npm test` and fatal to whoever runs it first.
  const modules = await mjsFiles();
  for (const file of modules) {
    try { await exec(process.execPath, ['--check', file]); }
    catch (e) { problems.push(`${relative(REPO, file)}: does not parse\n    ${String(e.stderr).split('\n')[0]}`); }
  }

  // 2. Documented flags exist. This is the check that would have caught
  //    `--record-video` being advertised for the orchestrator that rejected it,
  //    and the `--output` hint on a CLI that only reads `--out`.
  const accepted = await acceptedFlags();
  const documented = await documentedFlags();
  const unknown = [...documented.entries()]
    .filter(([flag]) => !accepted.has(flag) && !EXTERNAL_FLAGS.has(flag))
    .map(([flag, file]) => `${file}: documents ${flag}, which no CLI accepts`)
    .sort();
  problems.push(...unknown);

  // 3. The root stays a landing page.
  const rootMd = (await readdir(REPO)).filter((f) => f.endsWith('.md')).sort();
  const extra = rootMd.filter((f) => !ROOT_MARKDOWN.includes(f));
  if (extra.length) {
    problems.push(`root has ${extra.length} markdown file(s) beyond ${ROOT_MARKDOWN.join(', ')}: ${extra.join(', ')}`);
  }

  // 4. The paths every install instruction depends on are present.
  const required = [
    'package.json', 'README.md', 'LICENSE', '.claude-plugin/plugin.json',
    'install.sh', 'install.ps1', 'skills/design-extractor/SKILL.md',
  ];
  for (const rel of required) {
    if (!(await exists(join(REPO, rel)))) problems.push(`missing required file: ${rel}`);
  }

  // 5. Test files are matched by the runner's discovery rule.
  const tests = (await readdir(join(REPO, 'scripts', '__tests__'))).filter((f) => f.endsWith('.mjs'));
  const smokes = tests.filter((f) => !f.endsWith('.test.mjs') && !f.endsWith('.smoke.mjs'));
  for (const f of smokes) {
    problems.push(`scripts/__tests__/${f} is neither *.test.mjs nor *.smoke.mjs, so no runner picks it up`);
  }

  if (problems.length === 0) {
    process.stdout.write(`OK: ${modules.length} modules parse, ${documented.size} documented flags all exist, root is ${rootMd.join(' + ')}\n`);
    return;
  }
  for (const p of problems) process.stdout.write(`error: ${p}\n`);
  process.stdout.write(`\n${problems.length} problem(s). Run npm run lint after fixing.\n`);
  process.exitCode = 1;
  void sep;
}

await main();
