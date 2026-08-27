// sourcemap-pass.mjs - sourcemap extraction pass for --full mode.
// Extracted from inspect.mjs to keep it under the 400-line cap.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractFromSourceMap } from './sourcemap-extract.mjs';

async function walkJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) files = files.concat(await walkJsFiles(full));
    else if (e.isFile() && /\.(js|mjs|cjs)$/.test(e.name)) files.push(full);
  }
  return files;
}

export async function sourcemapPass(net, args, outDir) {
  const origin = new URL(args.url).origin;
  const netJs = net
    .filter(r => r.url && r.url.startsWith(origin) && (r.url.endsWith('.js') || r.url.endsWith('.mjs') || r.url.endsWith('.cjs')))
    .map(r => r.url);
  let siteJs = [];
  if (args.siteDir) {
    siteJs = await walkJsFiles(args.siteDir);
  }
  const allJs = Array.from(new Set([...netJs, ...siteJs]));
  const jsSourcemap = [];
  const jsInferred = [];
  for (const urlOrPath of allJs) {
    try {
      let content;
      if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
        const resp = await fetch(urlOrPath);
        if (!resp.ok) continue;
        content = await resp.text();
      } else {
        content = await readFile(urlOrPath, 'utf8');
      }
      const result = await extractFromSourceMap(content, urlOrPath, outDir);
      if (result.fidelity === 'js-sourcemap') {
        jsSourcemap.push(result);
      } else if (result.fidelity === 'js-inferred') {
        jsInferred.push(result);
      }
    } catch {
      // skip individual failures
    }
  }
  return { jsSourcemap, jsInferred };
}
