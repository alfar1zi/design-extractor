#!/usr/bin/env node
// saveweb2zip.mjs - port of saveweb2zip.ps1 to Node.js ESM.
// API: POST /api/copySite -> poll /api/getStatus/{md5} -> GET /api/downloadArchive/{md5}
// yauzl is lazily imported inside extractZip so pure-logic tests can import
// helpers from this file without the dep being installed.

import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { createWriteStream, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join, sep, posix, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertSafeUrl } from './url-safety.mjs';

const API = 'https://copier.saveweb2zip.com';
const REFERER = 'https://saveweb2zip.com/en';
const POLL_MS = 5000;

// ---- pure helpers (exported for tests) ----

export function defaultOutDir(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return resolve(process.cwd(), `ref_${ts}`);
}

export function parseArgs(argv) {
  const out = { url: null, outDir: null, renameAssets: false, saveStructure: false, alternativeAlgorithm: false, mobileVersion: false, timeoutSec: 300, json: null, allowPrivate: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--url': out.url = next(); break;
      case '--out': out.outDir = next(); break;
      case '--rename-assets': out.renameAssets = true; break;
      case '--save-structure': out.saveStructure = true; break;
      case '--alternative-algorithm': out.alternativeAlgorithm = true; break;
      case '--mobile-version': out.mobileVersion = true; break;
      case '--timeout': out.timeoutSec = Number(next()); break;
      case '--json': out.json = next(); break;
      case '--allow-private': out.allowPrivate = true; break;
      case '-h': case '--help': out.help = true; break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  if (out.help) return out;
  if (!out.url) throw new Error('--url is required');
  if (!Number.isFinite(out.timeoutSec) || out.timeoutSec <= 0) throw new Error('--timeout must be a positive number');
  return out;
}

export function safeJoin(outDir, entryName) {
  if (!entryName || entryName.includes('\0')) throw new Error(`bad entry name: ${entryName}`);
  const norm = entryName.replace(/\\/g, '/');
  if (posix.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) throw new Error(`absolute path in zip: ${entryName}`);
  const parts = norm.split('/').filter((p) => p.length > 0);
  for (const p of parts) if (p === '..') throw new Error(`zip-slip: ${entryName}`);
  const target = resolve(join(outDir, ...parts));
  const root = resolve(outDir);
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`zip-slip: ${entryName}`);
  return target;
}

async function findFirstHtml(outDir) {
  const hits = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.html?$/i.test(e.name)) hits.push(full);
    }
  };
  await walk(outDir);
  return hits.sort()[0] || null;
}

// ---- pretty printing ----
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const out = (msg) => process.stdout.write(`[save] ${msg}\n`);
const err = (msg) => process.stderr.write(`[save] ${wrap('31', msg)}\n`);
const info = (m) => out(wrap('36', m));
const dim  = (m) => out(wrap('90', m));
const ok   = (m) => out(wrap('32', m));

const HELP = `design-extractor-save -- download a full site via saveweb2zip
Usage: design-extractor-save --url <URL> [options]
Options:
  --url <URL>              target site (required)
  --out <DIR>              output directory (default: ./ref_YYYYMMDD_HHmmss)
  --rename-assets          rename hashed assets
  --save-structure         preserve site URL structure
  --alternative-algorithm  simplified static download
  --mobile-version         capture mobile variant
  --timeout <sec>          poll timeout in seconds (default: 300)
  --json <file>            write manifest JSON to file
  --allow-private          allow private/loopback URLs (off by default; SSRF guard)
  -h, --help               show this help
`;

const exit = async (code, fn, ...args) => { try { return await fn(...args); } catch (e) { err(e.message); process.exit(code); } };

// ---- network ----

async function copySite(url, opts) {
  const res = await fetch(`${API}/api/copySite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: REFERER },
    body: JSON.stringify({ url, renameAssets: !!opts.renameAssets, saveStructure: !!opts.saveStructure, alternativeAlgorithm: !!opts.alternativeAlgorithm, mobileVersion: !!opts.mobileVersion }),
  });
  if (!res.ok) throw new Error(`copySite HTTP ${res.status}`);
  const j = await res.json();
  if (!j.md5) throw new Error(`no md5 in response: ${JSON.stringify(j)}`);
  return j.md5;
}

async function pollStatus(md5, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await fetch(`${API}/api/getStatus/${md5}`, { headers: { referer: REFERER } });
    if (!res.ok) throw new Error(`getStatus HTTP ${res.status}`);
    last = await res.json();
    dim(`status: copied=${last.copiedFilesAmount} finished=${last.isFinished} success=${last.success}`);
    if (last.isFinished) return last;
  }
  throw new Error(`TIMEOUT after ${timeoutSec}s (last copied=${last?.copiedFilesAmount ?? 0})`);
}

async function downloadArchive(md5, dest) {
  const res = await fetch(`${API}/api/downloadArchive/${md5}`, { headers: { referer: REFERER } });
  if (!res.ok) throw new Error(`downloadArchive HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

// Pure retry helper. (delays.length + 1) total attempts with the configured backoff.
// Throws `<label> failed after N attempts: <cause>` once exhausted.
const RETRY_DELAYS_MS = [500, 1000, 2000];
export async function withRetry(fn, label, delays = RETRY_DELAYS_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < delays.length) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  const cause = lastErr?.message ?? String(lastErr);
  throw new Error(`${label} failed after ${delays.length + 1} attempts: ${cause}`);
}

// Fallback: monolith (single-page static) or single-file-cli (headless Chromium).
// Spawns the CLI, captures stdout/stderr, returns the output file path.
export async function runFallbackCli(cmd, args, outFile, { timeoutMs = 120000 } = {}) {
  await new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (e) => { clearTimeout(timer); rejectP(new Error(`${cmd} spawn failed: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return rejectP(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200)}`));
      resolveP({ stdout, stderr });
    });
  });
  return outFile;
}

// Orchestrates the full save flow: saveweb2zip with retry, fallback to monolith/single-file-cli
// if saveweb2zip fails. Returns { backend, outFile, ... }.
export async function downloadSiteWithFallback(url, outDir, opts = {}) {
  await assertSafeUrl(url, { allowPrivate: !!opts.allowPrivate });
  const sleep = opts.sleep;
  const archiveDir = opts.archiveDir || join(outDir, 'site');
  await mkdir(archiveDir, { recursive: true });

  let lastErr = null;
  try {
    const md5 = await withRetry(() => copySite(url, opts), 'copySite');
    const status = await withRetry(() => pollStatus(md5, opts.timeoutSec || 300), 'pollStatus');
    if (status.success === false) throw new Error(`saveweb2zip reported failure: ${status.error || 'unknown'}`);
    const zipPath = join(outDir, `site_${md5}.zip`);
    const zipSize = await withRetry(() => downloadArchive(md5, zipPath), 'downloadArchive');
    return { backend: 'saveweb2zip', zipPath, zipSize };
  } catch (e) {
    lastErr = e;
    err(`saveweb2zip failed after retries: ${e.message}`);
  }

  // Fallback 1: monolith
  if (opts.allowFallback !== false) {
    try {
      const out = join(archiveDir, 'monolith.html');
      await runFallbackCli('npx', ['--yes', 'monolith', url, '-o', out], out);
      info(`fallback OK: monolith -> ${out}`);
      return { backend: 'monolith', outFile: out };
    } catch (e) {
      err(`monolith fallback failed: ${e.message}`);
    }
    // Fallback 2: single-file-cli
    try {
      const out = join(archiveDir, 'single-file.html');
      await runFallbackCli('npx', ['--yes', 'single-file-cli', url, '--output-file', out], out);
      info(`fallback OK: single-file-cli -> ${out}`);
      return { backend: 'single-file-cli', outFile: out };
    } catch (e) {
      err(`single-file-cli fallback failed: ${e.message}`);
    }
  }

  throw lastErr || new Error('all backends failed');
}

// ---- zip extract ----
function extractZip(zipPath, outDir) {
  return new Promise(async (resolveP, rejectP) => {
    const { default: yauzl } = await import('yauzl');
    yauzl.open(zipPath, { lazyEntries: true }, (errOpen, zipfile) => {
      if (errOpen) return rejectP(errOpen);
      let count = 0;
      zipfile.on('error', rejectP);
      zipfile.on('end', () => resolveP(count));
      zipfile.on('entry', (entry) => {
        try {
          if (/\/$/.test(entry.fileName)) return zipfile.readEntry();
          const target = safeJoin(outDir, entry.fileName);
          mkdirSync(dirname(target), { recursive: true });
          zipfile.openReadStream(entry, (errRS, rs) => {
            if (errRS) return rejectP(errRS);
            const ws = createWriteStream(target);
            ws.on('error', rejectP);
            ws.on('finish', () => { count++; zipfile.readEntry(); });
            rs.pipe(ws);
          });
        } catch (e) { rejectP(e); }
      });
      zipfile.readEntry();
    });
  });
}

// ---- main ----
async function main() {
  const args = await exit(2, parseArgs, process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }

  try { await assertSafeUrl(args.url, { allowPrivate: !!args.allowPrivate }); }
  catch (e) { err(e.message); process.exit(2); }

  const outDir = args.outDir ? resolve(args.outDir) : defaultOutDir();
  await mkdir(outDir, { recursive: true });
  info(`Submitting: ${args.url}`);
  dim(`OutDir: ${outDir}`);

  try {
    const result = await downloadSiteWithFallback(args.url, outDir, { ...args });
    if (result.backend === 'saveweb2zip') {
      const { zipPath, zipSize } = result;
      ok(`OK: ${zipPath} (${(zipSize / 1024).toFixed(1)} KB)`);
      const siteDir = join(outDir, 'site');
      await mkdir(siteDir, { recursive: true });
      const count = await exit(1, extractZip, zipPath, siteDir);
      await rm(zipPath, { force: true });
      const entry = await findFirstHtml(siteDir);
      ok(`Extracted: ${count} files -> ${siteDir}`);
      if (entry) dim(`Entry: ${entry}`);
      if (args.json) {
        await writeFile(args.json, JSON.stringify({ url: args.url, backend: 'saveweb2zip', outDir, zipSize: zipSize, fileCount: count, entry }, null, 2));
        dim(`Manifest: ${args.json}`);
      }
    } else {
      ok(`OK via fallback: ${result.backend} -> ${result.outFile}`);
      if (args.json) {
        await writeFile(args.json, JSON.stringify({ url: args.url, backend: result.backend, outDir, outFile: result.outFile }, null, 2));
        dim(`Manifest: ${args.json}`);
      }
    }
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { err(e.stack || e.message); process.exit(1); });
}
