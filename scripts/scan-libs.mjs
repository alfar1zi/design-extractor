// scan-libs.mjs - scan a site source directory for animation library fingerprints.
// Exported as a pure function; used by inspect.mjs via dynamic import so it can be
// unit-tested independently.

import { readdir, readFile } from 'node:fs/promises';
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

// Scan the top-level js/ subdir of siteDir for animation library fingerprints.
// Reads only the first 50KB of each .js file. Non-recursive (js/ only).
// Returns { [libName]: { found: boolean, files: string[] } }.
export async function scanAnimationLibs(siteDir) {
  const results = Object.fromEntries(Object.keys(ANIM_LIB_PATTERNS).map((k) => [k, { found: false, files: [] }]));
  const jsDir = join(siteDir, 'js');
  let entries;
  try { entries = await readdir(jsDir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.js')) continue;
    const full = join(jsDir, e.name);
    let chunk;
    try { chunk = (await readFile(full, 'utf8')).slice(0, 50000); } catch { continue; }
    for (const [lib, pattern] of Object.entries(ANIM_LIB_PATTERNS)) {
      if (pattern.test(chunk)) {
        results[lib].found = true;
        results[lib].files.push(full);
      }
    }
  }
  return results;
}
