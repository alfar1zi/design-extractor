// scan-libs.mjs - scan a site source directory for animation library fingerprints.
// Exported as a pure function; used by inspect.mjs via dynamic import so it can be
// unit-tested independently.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ANIM_LIB_PATTERNS = {
  gsap:          /\bgsap\b/i,
  ScrollTrigger: /ScrollTrigger/,
  Lenis:         /\bLenis\b/,
  framerMotion:  /framer-motion|useAnimate/,
  motionOne:     /@motionone|motion\.dev/,
  anime:         /anime\.js|anime\(/,
  AOS:           /\bAOS\b/,
  scrollReveal:  /[Ss]croll[Rr]eveal/,
  Intersection:  /IntersectionObserver/,
};

const JS_EXTS = new Set(['.js', '.mjs', '.cjs']);

// Tunable caps so a giant vendor bundle does not stall the scan.
const DEFAULT_OPTS = {
  maxFiles: 200,
  maxBytesPerFile: 50000,
  maxTotalBytes: 5_000_000,
  excludeDirs: new Set(['node_modules', '.git', 'source-maps']),
  excludeExts: new Set(['.map', '.css', '.html', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.otf', '.ico']),
};

// Walk siteDir recursively, collecting .js/.mjs/.cjs files up to the configured caps.
// Exported so tests can assert the candidate set without going through the full scan.
export async function walkJsFiles(siteDir, opts = {}) {
  const { maxFiles, maxBytesPerFile, maxTotalBytes, excludeDirs, excludeExts } = { ...DEFAULT_OPTS, ...opts };
  const candidates = [];
  let totalBytes = 0;
  const stop = () => candidates.length >= maxFiles || totalBytes >= maxTotalBytes;

  async function walk(dir) {
    if (stop()) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (stop()) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (excludeDirs.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf('.');
        const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : '';
        if (excludeExts.has(ext)) continue;
        if (!JS_EXTS.has(ext)) continue;
        candidates.push(full);
        try {
          const st = await stat(full);
          totalBytes += Math.min(st.size, maxBytesPerFile);
        } catch { /* unreadable; counted by path */ }
      }
    }
  }

  await walk(siteDir);
  return candidates;
}

// Scan siteDir recursively for animation library fingerprints.
// Reads up to maxBytesPerFile per file. Walks up to maxFiles files or maxTotalBytes.
export async function scanAnimationLibs(siteDir, opts = {}) {
  const { maxBytesPerFile } = { ...DEFAULT_OPTS, ...opts };
  const results = Object.fromEntries(Object.keys(ANIM_LIB_PATTERNS).map((k) => [k, { found: false, files: [] }]));
  const candidates = await walkJsFiles(siteDir, opts);
  for (const full of candidates) {
    let chunk;
    try { chunk = (await readFile(full, 'utf8')).slice(0, maxBytesPerFile); } catch { continue; }
    for (const [lib, pattern] of Object.entries(ANIM_LIB_PATTERNS)) {
      if (pattern.test(chunk)) {
        results[lib].found = true;
        if (!results[lib].files.includes(full)) results[lib].files.push(full);
      }
    }
  }
  return results;
}
