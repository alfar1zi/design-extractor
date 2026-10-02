// tree-writer.mjs - materialise the capture store as a browsable tree on disk.
// The point of the tree is that it opens with the network switched off.

import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { rewriteCss, rewriteHtml, rewriteJs } from './rewrite.mjs';
import { assertInsideRoot } from './url-tree.mjs';
import { treeResolver } from './request-intercept.mjs';

const REWRITERS = { html: rewriteHtml, css: rewriteCss, js: rewriteJs };

/**
 * Write every captured body to <outDir>/<rel>, rewriting references so the tree
 * resolves internally.
 *
 * @param {ReturnType<import('./capture-store.mjs').createCaptureStore>} store
 * @returns {Promise<{written: number, bytes: number, missed: Array<{url: string, rel: string}>}>}
 */
export async function writeTree(store, { outDir }) {
  const { entries } = store.captureStats();
  // Cleared first. `mkdir({recursive:true})` leaves whatever the previous run
  // wrote, so two captures into one `--out` merged into a tree holding both runs'
  // bytes with nothing marking which was which.
  //
  // Removed by path, not by `realpath` of it: `rm` on a symlink unlinks the link
  // and leaves the target alone, while `rm(realpath(link))` deletes the directory
  // the link pointed at. Resolving first here would destroy whatever the user
  // had symlinked `--out` at.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  return await writeCaptured(outDir, entries, store);
}

/**
 * Rewrite and emit every captured body under <root>/<rel>, reporting the
 * references that pointed somewhere the capture never reached.
 */
async function writeCaptured(root, entries, store) {
  let written = 0;
  let bytes = 0;
  const missed = [];

  // Write through a temp name and rename into place. A half-written file left by
  // a killed run is indistinguishable from a real one, and a tree is read by
  // opening it in a browser, where a truncated stylesheet fails silently. The
  // ceiling: `rename` is atomic within a filesystem, so an `--out` spanning two
  // mounts degrades to a non-atomic copy rather than to corruption.
  const emit = async (dest, buf) => {
    const tmp = `${dest}.de-${process.pid}-${written}`;
    try {
      await writeFile(tmp, buf);
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  };

  for (const entry of entries) {
    const stored = store.get(entry.url);
    if (!stored) continue;
    const rel = entry.rel;
    const dest = assertInsideRoot(root, rel);
    await mkdir(dirname(dest), { recursive: true });

    const kind = rewriteKind(entry.contentType, rel);
    if (!kind) {
      await emit(dest, stored.body);
      written++; bytes += stored.body.length;
      continue;
    }

    // The document being rewritten is the reference point for every relative path
    // in it. `treeResolver` is the single implementation of that mapping, shared
    // with anything else that has to name a captured URL from inside a document.
    const resolver = treeResolver(store, { docUrl: entry.url });
    const result = REWRITERS[kind](stored.body.toString('utf8'), {
      baseUrl: entry.url,
      resolver,
      collect: (m) => missed.push(...m.map((x) => ({ ...x, rel }))),
    });
    const buf = Buffer.from(kind === 'html' ? result : result.text, 'utf8');
    await emit(dest, buf);
    written++; bytes += buf.length;
  }

  return { written, bytes, missed };
}

function rewriteKind(contentType, rel) {
  if (/html/i.test(contentType)) return 'html';
  if (/css/i.test(contentType)) return 'css';
  if (/javascript|ecmascript/i.test(contentType)) return 'js';
  if (/\.html?$/.test(rel)) return 'html';
  if (/\.css$/.test(rel)) return 'css';
  if (/\.m?js$/.test(rel)) return 'js';
  return null;
}
