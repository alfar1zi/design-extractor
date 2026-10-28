// tree-writer.mjs - materialise the capture store as a browsable tree on disk.
// The point of the tree is that it opens with the network switched off.

import { mkdir, writeFile, rename, rm, readdir, lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { rewriteCss, rewriteHtml, rewriteJs } from './rewrite.mjs';
import { assertInsideRoot } from './url-tree.mjs';
import { treeResolver } from './request-intercept.mjs';

const REWRITERS = { html: rewriteHtml, css: rewriteCss, js: rewriteJs };

/** Base name of the ownership record written beside a tree directory. */
export const TREE_MARKER = '.design-extractor-tree';

/**
 * Path of the file that records who wrote a tree directory.
 *
 * Deliberately a sibling, not an entry inside the tree: the tree is what a
 * consumer serves and enumerates, and it must be exactly the capture. A marker
 * inside it showed up as the first entry of `readdir(tree)`, which is how the
 * fidelity gate picks the host directory to serve, so the gate started loading a
 * directory listing as the page.
 */
export function treeMarkerPath(outDir) {
  const parent = dirname(outDir.replace(/[\\/]+$/, ''));
  return join(parent, `${TREE_MARKER}.${basename(outDir)}`);
}

/** True when a previous run of this tool created `outDir`. */
async function isOwnedTree(outDir) {
  try { await lstat(treeMarkerPath(outDir)); return true; }
  catch { return false; }
}

/**
 * Throw when clearing `outDir` would delete something this tool did not write.
 *
 * `--out` is user input that reaches `rm -rf` unexamined: pointing it at a
 * directory that already held something made the tree pass delete it and report
 * success. A directory the previous run wrote is safe to clear (the marker is
 * there); anything else needs `--force-tree`, so the default cannot destroy work.
 *
 * Separated from the clear so the caller can refuse before spending a browser
 * session, and so a failed capture never clears the tree it was going to replace.
 *
 * @param {string} outDir
 * @param {{force?: boolean}} [opts]
 */
export async function assertTreeDirClearable(outDir, { force = false } = {}) {
  let info = null;
  try { info = await lstat(outDir); } catch { return true; }
  // A symlink is unlinked, never followed: `rm` on a link removes the link, while
  // resolving it first would delete whatever it pointed at.
  if (info.isSymbolicLink()) return true;
  if (!info.isDirectory()) throw new Error(`tree: ${outDir} exists and is not a directory`);
  const names = await readdir(outDir);
  if (names.length > 0 && !(await isOwnedTree(outDir)) && !force) {
    throw new Error(
      `tree: refusing to delete ${outDir}: it holds ${names.length} `
      + 'entries this tool did not write. Pass --force-tree to overwrite it anyway.',
    );
  }
  return true;
}

/** Clear and re-create the tree directory, then record the output as ours. */
export async function prepareTreeDir(outDir, { force = false } = {}) {
  await assertTreeDirClearable(outDir, { force });
  let info = null;
  try { info = await lstat(outDir); } catch { /* absent */ }
  if (info && info.isDirectory() && !info.isSymbolicLink()) {
    await rm(outDir, { recursive: true, force: true });
  } else if (info) {
    await rm(outDir, { force: true });
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(treeMarkerPath(outDir), 'design-extractor capture tree - generated, safe to delete\n');
  return outDir;
}

/**
 * Write every captured body to <outDir>/<rel>, rewriting references so the tree
 * resolves internally.
 *
 * @param {ReturnType<import('./capture-store.mjs').createCaptureStore>} store
 * @returns {Promise<{written: number, bytes: number, missed: Array<{url: string, rel: string}>}>}
 */
export async function writeTree(store, { outDir, force = false }) {
  const { entries } = store.captureStats();
  await prepareTreeDir(outDir, { force });

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
