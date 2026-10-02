#!/usr/bin/env node
// cli.mjs - top-level orchestrator: runs inspect (browser capture) -> optional legacy source download.

import { spawn } from 'node:child_process';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSafeUrl } from './url-safety.mjs';

const DEFAULT_VIEWPORT = '1440x900';
const DEFAULT_TIMEOUT = 30;

// ---- pure helpers (exported for tests) ----

export function parseArgs(argv) {
  const out = { url: null, outDir: null, viewport: DEFAULT_VIEWPORT, timeout: DEFAULT_TIMEOUT, scroll: true, interactions: true, sweep: true, states: true, skipSave: false, skipInspect: false, legacySource: false, allowPrivate: false, help: false, sourcemap: false, targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--target': {
        const val = (next() || '').trim();
        if (!val) throw new Error('--target needs a CSS selector, e.g. --target ".pricing-card"');
        out.targets.push(val);
        break;
      }
      case '--out': out.outDir = next(); break;
      case '--viewport': {
        const val = next();
        if (!/^\d+x\d+$/.test(val || '')) throw new Error('--viewport must be WxH, e.g. 1440x900');
        out.viewport = val;
        break;
      }
      case '--timeout': out.timeout = Number(next()); break;
      case '--no-scroll': out.scroll = false; break;
      case '--no-interactions': out.interactions = false; break;
      case '--no-sweep': out.sweep = false; break;
      case '--no-states': out.states = false; break;
      case '--skip-save': out.skipSave = true; break;
      case '--skip-inspect': out.skipInspect = true; break;
      case '--legacy-source': out.legacySource = true; break;
      case '--allow-private': out.allowPrivate = true; break;
      case '-h': case '--help': out.help = true; break;
      case '--quick':
        out.scroll = false;
        out.interactions = false;
        out.sweep = false;
        out.states = false;
        out.sourcemap = false;
        break;
      case '--full':
        out.scroll = true;
        out.interactions = true;
        out.sweep = true;
        out.states = true;
        out.sourcemap = true;
        break;
      case '--standard':
        // default, no change
        break;
      case '--fidelity': out.fidelity = next(); break;
      case '--sourcemap':
        out.sourcemap = true;
        break;
      default:
        // A token starting with `-` is a flag, always. Falling through to `out.url`
        // instead made `--site-dir /tmp/x` fail with "unknown flag: /tmp/x", naming
        // the value the user passed rather than the flag they mistyped.
        if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
        if (out.url) throw new Error(`unexpected argument: ${a} (the url is already "${out.url}")`);
        out.url = a;
    }
  }
  if (out.help) return out;
  if (!out.url) throw new Error('url is required (positional)');
  // Syntax + SSRF validation happens in main() via validateUrl/assertSafeUrl
  // so parseArgs stays sync and tests can import validateUrl directly.
  if (!/^\d+x\d+$/.test(out.viewport)) throw new Error('--viewport must be WxH, e.g. 1440x900');
  if (!Number.isFinite(out.timeout) || out.timeout <= 0) throw new Error('--timeout must be a positive number');
  return out;
}

// Validate URL: syntax check + SSRF guard. Throws on bad URL or unsafe target.
// Defaults allowPrivate=false; pass allowPrivate=true to permit loopback/private IPs.
export async function validateUrl(rawUrl, opts = {}) {
  const { allowPrivate = false, resolver } = opts;
  const args = { allowPrivate };
  if (resolver) args.resolver = resolver;
  await assertSafeUrl(rawUrl, args);
  return true;
}

export function buildChildArgs(opts) {
  const args = [];
  // The save step POSTs the target URL to a third-party copier, so it is opt-in only.
  if (opts.legacySource && !opts.skipSave) {
    const saveArgs = ['--url', opts.url, '--out', join(opts.out, 'site')];
    if (opts.allowPrivate) saveArgs.push('--allow-private');
    args.push(['save', saveArgs]);
  }
  if (!opts.skipInspect) {
    const inspect = ['--url', opts.url, '--out', join(opts.out, 'live'), '--viewport', opts.viewport, '--timeout', String(opts.timeout)];
    // Only pass --site-dir when the legacy source download actually ran.
    if (opts.legacySource && !opts.skipSave) inspect.push('--site-dir', join(opts.out, 'site'));
    if (!opts.scroll) inspect.push('--no-scroll');
    if (!opts.interactions) inspect.push('--no-interactions');
    if (!opts.sweep) inspect.push('--no-sweep');
    if (!opts.states) inspect.push('--no-states');
    if (opts.allowPrivate) inspect.push('--allow-private');
    if (opts.fidelity) inspect.push('--fidelity', opts.fidelity);
    if (opts.sourcemap) inspect.push('--sourcemap');
    for (const t of opts.targets || []) inspect.push('--target', t);
    args.push(['inspect', inspect]);
  }
  return args;
}


function defaultOutDir(url, now = new Date()) {
  let host = 'site';
  try { host = new URL(url).host.replace(/[^a-z0-9.-]/gi, '_') || 'site'; } catch { /* keep site */ }
  const p = (n) => String(n).padStart(2, '0');
  return resolve(process.cwd(), `ref_${host}_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`);
}

function scriptPath(name) {
  return join(dirname(fileURLToPath(import.meta.url)), name);
}

function runChild(name, args) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, [scriptPath(name), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => process.stdout.write(b));
    child.stderr.on('data', (b) => process.stderr.write(b));
    child.on('error', (e) => { err(`${name} spawn failed: ${e.message}`); resolveP({ code: 1, error: e }); });
    child.on('close', (code) => resolveP({ code: code ?? 1 }));
  });
}

async function countFiles(dir) {
  let n = 0;
  const walk = async (d) => {
    try {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else n++;
      }
    } catch { /* missing dir counts as 0 */ }
  };
  await walk(dir);
  return n;
}

// ---- pretty printing ----
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (msg) => process.stdout.write(`[cli] ${msg}\n`);
const err = (msg) => process.stderr.write(`[cli] ${wrap('31', msg)}\n`);
const info = (m) => out(wrap('36', m));
const dim  = (m) => out(wrap('90', m));
const ok   = (m) => out(wrap('32', m));
const head = (m) => out(wrap('33', m));

const HELP = `design-extractor -- website clone engine

Usage: design-extractor <url> [options]

Options:
  <url>                 target site URL (positional, required)
  --out <DIR>           output directory (default: ./ref_<host>_<YYYYMMDD_HHmmss>)
  --viewport WxH        viewport for inspect (default: 1440x900)
  --timeout <sec>       page goto timeout for inspect (default: 30)
  --quick               preset: disable all passes (scroll, interactions, sweep); sourcemap off
  --standard            preset: default behavior (scroll, interactions, sweep on; sourcemap off)
  --full                preset: enable all passes + sourcemap extraction
  --target <css>        clone one element and scope the analysis to it; repeatable
  --sourcemap           extract original function names from JS source maps
  --no-scroll           skip scroll screenshot pass
  --no-interactions     skip clickable interaction pass
  --no-sweep            skip tablet+mobile viewport sweep
  --fidelity <dir>      score a replica directory against the original
  --no-states           skip hover/focus/checked state capture
  --legacy-source       also POST the target URL to copier.saveweb2zip.com (off by default)
  --skip-save           skip source download step
  --skip-inspect        skip browser inspect step
  --allow-private       allow private/loopback URLs (off by default; SSRF guard)
  -h, --help            show this help

Steps: inspect (browser capture; writes the executable artifacts).
       saveweb2zip only runs with --legacy-source.
`;

// ---- main ----
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { err(e.message); process.exit(2); }
  if (args.help) { process.stdout.write(HELP); return; }

  try { await validateUrl(args.url, { allowPrivate: !!args.allowPrivate }); }
  catch (e) { err(e.message); process.exit(2); }

  const outDir = args.outDir ? resolve(args.outDir) : defaultOutDir(args.url);
  await mkdir(outDir, { recursive: true });
  info(`URL: ${args.url}`);
  dim(`OutDir: ${outDir}`);

  let partial = false;
  for (const [name, cargs] of buildChildArgs({ out: outDir, ...args })) {
    head(`\n=== ${name} ===`);
    const r = await runChild(name === 'save' ? 'saveweb2zip.mjs' : 'inspect.mjs', cargs);
    // 3 is the child's "captured, but a pass failed" code. The tree is on disk
    // and usable, so the output is still reported; the distinct exit lets a
    // caller tell a partial capture from a clean one without parsing stdout.
    if (r.code === 3) {
      err(`PARTIAL at ${name}: at least one pass failed - see live/manifest.json partialFailures`);
      partial = true;
    } else if (r.code !== 0) {
      err(`FAILED at ${name} (exit ${r.code})`);
      if (name === 'save') dim('hint: the browser capture is the primary artifact; the copier download is optional and can be skipped with --skip-save.');
      process.exit(1);
    }
  }

  const liveDir = join(outDir, 'live');

  const [files, liveN] = await Promise.all([countFiles(outDir), countFiles(liveDir)]);
  ok(`OK: ${outDir}`);
  dim(`  live:      ${liveDir} (${liveN} files)`);
  dim(`  total:     ${files} files`);
  const names = await readdir(liveDir).catch(() => []);
  const data = names.filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  if (data.length) dim(`  data:      ${data.join('  ')}`);
  if (partial) process.exit(3);
}

// realpath: npm installs the bins as symlinks under .bin, so argv[1] is the
// symlink path while import.meta.url is already the resolved one. Comparing the
// raw paths left this guard false under `npx`, so main() never ran and the
// process exited 0 having printed nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  main().catch((e) => { err(e.stack || e.message); process.exit(1); });
}
