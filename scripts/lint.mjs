#!/usr/bin/env node
// lint.mjs - repository invariants that a unit test cannot state.
//
// Three classes of defect kept appearing in this repository and none shows up in
// a test run: a flag documented in README.md or SKILL.md that no parser accepts,
// a file added at the root that a reader has to decide whether to open, and an em
// dash typed into prose the reader's font has to render.
// All are checkable from the tree, so they are checked here.
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

/** Every tracked file, not just the modules. Binary files declare themselves by
 * the NUL byte and are skipped on that evidence, not on a list of extensions. */
async function treeFiles(dir = REPO, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await treeFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Whether any other text file mentions a path, so an asset used only by the
 * skill or the tests is not reported as dead. */
async function referencedElsewhere(needle) {
  for (const file of await treeFiles()) {
    if (file.endsWith('README.md')) continue;
    const bytes = await readFile(file);
    if (bytes.includes(0)) continue;
    if (bytes.toString('utf8').includes(needle)) return true;
  }
  return false;
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

  // 6. Evidence logs stay plain text. `linear-v5.log` shipped as UTF-16LE with
  //    CRLF from a PowerShell redirect, so GitHub rendered the repository's proof
  //    as a binary blob and `.gitattributes` could not normalise it.
  const logDir = join(REPO, 'examples');
  for (const f of await readdir(logDir)) {
    if (!f.endsWith('.log')) continue;
    const bytes = await readFile(join(logDir, f));
    if (bytes.includes(0)) {
      problems.push(`examples/${f} is not UTF-8 text (contains NUL): GitHub renders it as binary`);
      continue;
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      problems.push(`examples/${f} starts with a UTF-8 BOM; logs are read as text and need none`);
    }
    if (bytes.includes(0x0d)) {
      problems.push(`examples/${f} contains CR; logs use LF so they diff and render cleanly`);
    }
  }

  // 7. No em dash. The character is read in fonts this repository does not pick,
  //    and the two installer tests already assert its absence from the files they
  //    install; checking the whole tree is what stops it coming back one file at a
  //    time. Checked as bytes, so a file the reader sees as text is judged as text.
  const emDash = Buffer.from('\u2014', 'utf8');
  for (const file of await treeFiles()) {
    const bytes = await readFile(file);
    if (bytes.includes(0)) continue;
    if (bytes.includes(emDash)) {
      problems.push(`${relative(REPO, file)} contains an em dash (U+2014); use a hyphen`);
    }
  }

  // 8. The repository page and the manifests say the same thing. GitHub's
  //    description, topics and package keywords are the text a search engine and
  //    an agent read first, and they drifted apart the moment they were edited in
  //    two places: the live description still advertised Node 18 while
  //    engines.node said 20. Checked against a versioned file, not the API.
  let meta = null;
  try { meta = JSON.parse(await readFile(join(REPO, '.github', 'repository-metadata.json'), 'utf8')); }
  catch (e) { problems.push(`.github/repository-metadata.json: ${e.code === 'ENOENT' ? 'missing' : 'does not parse'}`); }
  if (meta) {
    const desc = String(meta.description || '');
    // GitHub truncates the description in search results around 160 characters.
    if (desc.length < 40) problems.push('repository description is shorter than 40 characters; say what it does');
    if (desc.length > 160) problems.push(`repository description is ${desc.length} characters; keep it under 160 so search results do not truncate it`);
    if (!Array.isArray(meta.topics) || meta.topics.length < 5) problems.push('repository topics: at least 5 are needed to classify the repo');
    else if (meta.topics.length > 20) problems.push(`repository topics: GitHub allows 20, this file has ${meta.topics.length}`);
    else {
      for (const t of meta.topics) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t) || t.length > 35) problems.push(`repository topic ${JSON.stringify(t)} is not a valid GitHub topic`);
      }
    }

    const pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8'));
    if (!pkg.description) problems.push('package.json has no description; npm search shows nothing');
    else if (pkg.description.length > 160) problems.push(`package.json description is ${pkg.description.length} characters; keep it under 160`);
    if (!Array.isArray(pkg.keywords) || pkg.keywords.length < 5) problems.push('package.json needs at least 5 keywords for npm search');
  }

  // 9. Every shipped asset is referenced, and every image the README points at
  //    exists. An unreferenced asset is 300 KB of dead weight in every clone; a
  //    referenced one that is missing renders as a broken image on the repo page.
  const readme = await readFile(join(REPO, 'README.md'), 'utf8');
  for (const m of readme.matchAll(/(?:src|srcset)="([^"]+\.(?:svg|png|jpg|webp|gif))"/g)) {
    if (/^(?:https?:|\.\.\/)/.test(m[1])) continue;   // remote, or a path GitHub resolves (badges)
    if (!(await exists(join(REPO, m[1])))) problems.push(`README.md points at ${m[1]}, which is not in the repository`);
  }
  //    The social preview is uploaded to GitHub, not linked from markdown, so it
  //    is allowed to exist without a reference. Every other asset must be used.
  const DECLARED_ASSETS = new Set(['social-preview.png', 'social-preview.svg', 'logo.png', 'logo-dark.png']);
  const assetDir = join(REPO, 'assets');
  if (await exists(assetDir)) {
    for (const f of await readdir(assetDir)) {
      if (DECLARED_ASSETS.has(f)) continue;
      const used = readme.includes(`assets/${f}`) || (await referencedElsewhere(`assets/${f}`));
      if (!used) problems.push(`assets/${f} is referenced nowhere; delete it or document it`);
    }
  }

  if (problems.length === 0) {
    process.stdout.write(`OK: ${modules.length} modules parse, ${documented.size} documented flags all exist, root is ${rootMd.join(' + ')}, no em dashes, repository metadata is consistent\n`);
    return;
  }
  for (const p of problems) process.stdout.write(`error: ${p}\n`);
  process.stdout.write(`\n${problems.length} problem(s). Run npm run lint after fixing.\n`);
  process.exitCode = 1;
  void sep;
}

await main();
