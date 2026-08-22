#!/usr/bin/env node
// saveweb2zip.mjs - port of saveweb2zip.ps1 to Node.js ESM.
// API: POST /api/copySite -> poll /api/getStatus/{md5} -> GET /api/downloadArchive/{md5}
// yauzl is lazily imported inside extractZip so pure-logic tests can import
// helpers from this file without the dep being installed.

import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve, join, sep, posix, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const out = { url: null, outDir: null, renameAssets: false, saveStructure: false, alternativeAlgorithm: false, mobileVersion: false, timeoutSec: 300, json: null, help: false };
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

  const outDir = args.outDir ? resolve(args.outDir) : defaultOutDir();
  await mkdir(outDir, { recursive: true });
  info(`Submitting: ${args.url}`);
  dim(`OutDir: ${outDir}`);

  const md5 = await exit(1, (u) => copySite(u, args), args.url);
  dim(`Job: ${md5}`);

  const status = await exit(1, pollStatus, md5, args.timeoutSec);
  if (status.success === false) { err(`Copy failed: ${status.error || 'unknown'}`); process.exit(1); }

  const zipPath = join(outDir, `site_${md5}.zip`);
  const zipSize = await exit(1, downloadArchive, md5, zipPath);
  ok(`OK: ${zipPath} (${(zipSize / 1024).toFixed(1)} KB)`);

  const siteDir = join(outDir, 'site');
  await mkdir(siteDir, { recursive: true });
  const count = await exit(1, extractZip, zipPath, siteDir);
  await rm(zipPath, { force: true });

  const entry = await findFirstHtml(siteDir);
  ok(`Extracted: ${count} files -> ${siteDir}`);
  if (entry) dim(`Entry: ${entry}`);

  if (args.json) {
    await writeFile(args.json, JSON.stringify({ url: args.url, md5, outDir, zipSize, fileCount: count, entry }, null, 2));
    dim(`Manifest: ${args.json}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { err(e.stack || e.message); process.exit(1); });
}
