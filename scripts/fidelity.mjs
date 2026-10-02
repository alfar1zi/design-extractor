// fidelity.mjs - measure how far a rebuild is from the page it was cloned from.
//
// The comparison is against the captured original on disk, not against a
// description of it. A designer's eye misses a 2px offset and a screenshot
// difference does not.
//
// looks-same only populates differentPixels/totalPixels when createDiffImage is
// set AND the images differ, so both fields are undefined on an exact match.
// `diffRatio` is computed here for that reason: the library has no such field,
// and reporting `undefined` for a perfect match would read as a broken capture.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import looksSame from 'looks-same';

// Antialiasing and the caret move between runs of the same page, so they are
// noise here; clustering is not, because the bounding boxes are the only part
// of the result that says *where* a rebuild went wrong.
const DEFAULT_LOOKS_SAME = {
  ignoreAntialiasing: true,
  ignoreCaret: true,
  antialiasingTolerance: 2.3,
  shouldCluster: true,
  clustersSize: 10,
};

const PNG = /\.png$/i;

/** looks-same has no ratio; 0 on an exact match is 0, not undefined. */
function ratioOf({ equal, differentPixels, totalPixels }) {
  const total = totalPixels ?? 0;
  return total > 0 ? (differentPixels ?? 0) / total : equal === true ? 0 : 1;
}

/** One looks-same call, normalised. Every comparison in this file goes through here. */
async function diff(expectedPath, actualPath, options) {
  const result = await looksSame(expectedPath, actualPath, options);
  return {
    equal: result.equal === true,
    diffRatio: ratioOf(result),
    differentPixels: result.differentPixels ?? null,
    totalPixels: result.totalPixels ?? null,
    diffBounds: result.diffBounds ?? null,
    diffClusters: result.diffClusters || [],
  };
}

/**
 * Compare two images.
 *
 * @param {string} expectedPath
 * @param {string} actualPath
 * @param {{antialiasingTolerance?: number}} [opts]
 */
export async function compareImages(expectedPath, actualPath, { antialiasingTolerance = 0.1 } = {}) {
  const r = await diff(expectedPath, actualPath, {
    strict: false,
    ignoreAntialiasing: true,
    antialiasingTolerance,
    createDiffImage: true,
  });
  return {
    equal: r.equal,
    diffRatio: r.diffRatio,
    differentPixels: r.differentPixels,
    totalPixels: r.totalPixels,
    clusters: r.diffClusters.length,
    bounds: r.equal ? null : r.diffBounds,
  };
}

/**
 * Reduce looks-same's raw clusters to what a consumer acts on: how many
 * regions differ, and the box of the biggest one.
 *
 * looks-same emits `{left, top, right, bottom}` with INCLUSIVE maximum
 * coordinates, so width is `right - left + 1`. On an exact match it still emits
 * one area of `{left: Infinity, right: -Infinity}` — a DiffArea nothing ever
 * updated — and counting that would report a perfect run as one cluster, so
 * non-finite areas are dropped.
 *
 * A ratio with no cluster means the comparison did not report where it differs;
 * that is `clusteringFailed`, not a good score.
 *
 * @param {{diffRatio?: number, totalPixels?: number|null, diffClusters?: Array}} result
 */
export function clusterSummary({ diffRatio = 0, totalPixels = null, diffClusters = [] } = {}) {
  const boxes = diffClusters
    .filter((c) => c && Number.isFinite(c.left) && Number.isFinite(c.top) && c.right >= c.left && c.bottom >= c.top)
    .map((c) => ({ left: c.left, top: c.top, width: c.right - c.left + 1, height: c.bottom - c.top + 1 }));

  const worst = boxes.reduce((max, b) => (b.width * b.height > (max ? max.width * max.height : 0) ? b : max), null);
  const total = totalPixels && totalPixels > 0 ? totalPixels : null;

  return {
    clusters: boxes.length,
    worstCluster: worst && { box: worst, ratio: total ? (worst.width * worst.height) / total : null },
    clusteringFailed: diffRatio > 0 && boxes.length === 0,
  };
}

/** How far off a rebuild is before it stops being the same page. */
export function verdict(diffRatio) {
  if (diffRatio === 0) return 'identical';
  if (diffRatio < 0.001) return 'near-identical';
  if (diffRatio < 0.01) return 'close';
  if (diffRatio < 0.05) return 'diverging';
  return 'different';
}

/**
 * Compare two screenshot directories by filename.
 *
 * A name present on one side only is reported as missing, not skipped: a rebuild
 * that dropped half the screenshots would otherwise score as a clean run.
 *
 * @param {string} expectedDir
 * @param {string} actualDir
 */
export async function compareDirectories(expectedDir, actualDir) {
  const list = async (dir) => (await readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  const [expectedFiles, actualFiles] = await Promise.all([list(expectedDir), list(actualDir)]);
  const names = [...new Set([...expectedFiles, ...actualFiles])];

  const comparisons = [];
  for (const name of names) {
    if (!expectedFiles.includes(name)) {
      comparisons.push({ name, status: 'extra', detail: 'present in the rebuild only' });
      continue;
    }
    if (!actualFiles.includes(name)) {
      comparisons.push({ name, status: 'missing', detail: 'present in the capture only' });
      continue;
    }
    try {
      const c = await compareImages(join(expectedDir, name), join(actualDir, name));
      comparisons.push({ name, status: 'compared', ...c, verdict: verdict(c.diffRatio) });
    } catch (e) {
      comparisons.push({ name, status: 'error', detail: e.message.split('\n')[0] });
    }
  }

  const compared = comparisons.filter((c) => c.status === 'compared');
  const worst = compared.reduce((max, c) => (c.diffRatio > (max?.diffRatio ?? -1) ? c : max), null);
  return {
    expectedDir,
    actualDir,
    counts: {
      compared: compared.length,
      missing: comparisons.filter((c) => c.status === 'missing').length,
      extra: comparisons.filter((c) => c.status === 'extra').length,
      errored: comparisons.filter((c) => c.status === 'error').length,
    },
    worst: worst && { name: worst.name, diffRatio: worst.diffRatio },
    // A run with nothing comparable in it is not a passing run.
    overall: compared.length === 0 ? 'not-measured'
      : worst.diffRatio === 0 ? 'identical'
        : worst.diffRatio < 0.01 ? 'close' : 'diverging',
    comparisons,
  };
}

const stem = (name) => name.replace(PNG, '');

/** Screenshot files in a directory, keyed by name without `.png`. */
async function readShots(dir) {
  const shots = new Map();
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    // A capture directory that was never written leaves every viewport missing,
    // which the per-viewport `missing` entries already say. Anything else is a
    // real read failure and is not this module's to swallow.
    if (e.code !== 'ENOENT') throw e;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // `screenshots/unreproducible/` is a directory holding its own evidence
    // crops, not a viewport. Scoring it produced a null-ratio row that read as
    // a capture failure and was never a comparison at all.
    if (entry.isDirectory()) continue;
    shots.set(stem(entry.name), { path: join(dir, entry.name), isPng: PNG.test(entry.name) });
  }
  return shots;
}

/**
 * Score a rebuild against the capture it was cloned from, one viewport at a time.
 *
 * Both directories must come from the SAME capture: one Chromium instance, one
 * viewport, `deviceScaleFactor: 1`. Playwright documents that rendering varies
 * by host OS, browser version and headless mode, so a diff between two
 * machines measures the machines, not the rebuild.
 *
 * `compareDirectories` is not reused here: it is whole-directory equality over
 * flat names, and it drops the pixel counts and cluster boxes that this score is
 * made of. Only the looks-same call itself is shared, via `diff`.
 *
 * `viewports` defaults to whatever the two directories contain, so the caller
 * can score a subset. A viewport present on one side only gets an entry with a
 * null ratio and a `missing` note — never a pass. Nothing comparable at all
 * yields `measured: 0` and `status: 'not-measured'`, which is how an empty run
 * tells itself apart from a perfect one.
 *
 * @param {string} expectedDir
 * @param {string} actualDir
 * @param {{viewports?: string[], looksSameOptions?: object, unreproducible?: Record<string, unknown[]>}} [opts]
 */
export async function scoreFidelity(expectedDir, actualDir, { viewports, looksSameOptions, unreproducible = {} } = {}) {
  const options = { ...DEFAULT_LOOKS_SAME, ...looksSameOptions, strict: false, createDiffImage: true };
  const [expected, actual] = await Promise.all([readShots(expectedDir), readShots(actualDir)]);

  const names = viewports
    ? [...new Set(viewports.map((v) => stem(String(v))))]
    : [...new Set([...expected.keys(), ...actual.keys()])];

  const scored = [];
  for (const name of names) {
    const e = expected.get(name);
    const a = actual.get(name);
    const entry = {
      viewport: name,
      diffRatio: null,
      clusters: 0,
      worstCluster: null,
      missing: [],
      unreproducible: unreproducible[name] ?? [],
      error: null,
      clusteringFailed: false,
    };

    if (!e) entry.missing.push({ file: `${name}.png`, missingFrom: 'expected', detail: 'present in the rebuild only' });
    if (!a) entry.missing.push({ file: `${name}.png`, missingFrom: 'actual', detail: 'present in the capture only' });

    if (!e || !a) {
      scored.push(entry);
      continue;
    }
    if (!e.isPng || !a.isPng) {
      entry.error = `${name} is not a png screenshot`;
      scored.push(entry);
      continue;
    }

    try {
      const r = await diff(e.path, a.path, options);
      Object.assign(entry, clusterSummary(r), { diffRatio: r.diffRatio });
    } catch (err) {
      entry.error = err.message.split('\n')[0];
    }
    scored.push(entry);
  }

  const measured = scored.filter((v) => v.diffRatio !== null);
  const worst = measured.reduce((max, v) => (v.diffRatio > (max?.diffRatio ?? -1) ? v : max), null);

  return {
    expectedDir,
    actualDir,
    viewports: scored,
    // A consumer cannot read `measured: 0` as a perfect run: the perfect run
    // has an entry per viewport, each with diffRatio 0 and no clusters.
    measured: measured.length,
    missing: scored.filter((v) => v.missing.length > 0).length,
    worst: worst && { viewport: worst.viewport, diffRatio: worst.diffRatio },
    status: measured.length === 0 ? 'not-measured' : verdict(worst.diffRatio),
  };
}

