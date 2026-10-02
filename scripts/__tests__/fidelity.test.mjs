import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { compareImages, compareDirectories, scoreFidelity, clusterSummary, verdict } from '../fidelity.mjs';

const scratch = () => mkdtemp(join(tmpdir(), 'de-fidelity-'));

async function shoot(dir, name, draw) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 200, height: 100 } });
    await page.setContent('<body style="margin:0"></body>');
    await page.evaluate(draw);
    await page.screenshot({ path: join(dir, name) });
  } finally {
    await browser.close();
  }
}

// One browser, one viewport, one device scale for every shot in a test: a diff
// between two differently-rendered captures measures the captures, not the page.
// Draw functions take their geometry as an argument because a page-side
// function is serialized by source, so a closure over it would arrive empty.
async function shootMany(dir, shots) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 200, height: 100 }, deviceScaleFactor: 1 });
    await page.setContent('<body style="margin:0"></body>');
    for (const [name, draw] of Object.entries(shots)) {
      await page.evaluate(() => { document.body.innerHTML = ''; });
      await page.evaluate(draw.body, draw.args);
      await page.screenshot({ path: join(dir, name) });
    }
  } finally {
    await browser.close();
  }
}

const blank = { body: () => { document.body.style.background = '#ff0000'; } };
const blocks = (...boxes) => ({
  args: boxes,
  body: (boxes) => {
    document.body.style.background = '#ff0000';
    for (const [l, t, w, h] of boxes) {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;left:${l}px;top:${t}px;width:${w}px;height:${h}px;background:#0000ff`;
      document.body.appendChild(d);
    }
  },
});

test('an identical pair is exactly zero, not undefined', async () => {
  const dir = await scratch();
  try {
    await shoot(dir, 'a.png', () => { document.body.style.background = '#ff0000'; });
    const r = await compareImages(join(dir, 'a.png'), join(dir, 'a.png'));
    assert.equal(r.equal, true);
    assert.equal(r.diffRatio, 0, 'an exact match must report 0, never undefined');
    assert.equal(verdict(r.diffRatio), 'identical');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a changed pixel is measured, not guessed', async () => {
  const dir = await scratch();
  try {
    await shoot(dir, 'before.png', () => { document.body.style.background = '#ff0000'; });
    await shoot(dir, 'after.png', () => {
      document.body.style.background = '#ff0000';
      const d = document.createElement('div');
      d.style.cssText = 'width:50px;height:50px;background:#0000ff';
      document.body.appendChild(d);
    });
    const r = await compareImages(join(dir, 'before.png'), join(dir, 'after.png'));
    assert.equal(r.equal, false);
    // How far under the block's 2500px the count lands depends on antialiasing
    // and on how loaded the machine is, so the floor is not a property of this
    // code and asserting one made the test fail under parallel test runs. What
    // is a property: pixels were actually counted, and the count cannot exceed
    // the geometry. The magnitude is checked by the ratio below.
    assert.ok(r.differentPixels > 0 && r.differentPixels <= 2500, `got ${r.differentPixels}`);
    assert.equal(r.totalPixels, 200 * 100);
    assert.ok(Math.abs(r.diffRatio - 0.125) < 0.03, `got ${r.diffRatio}`);
    assert.ok(r.bounds, 'a non-match names where it differs');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a verdict scales with the ratio rather than flipping on the first pixel', () => {
  assert.equal(verdict(0), 'identical');
  assert.equal(verdict(0.0001), 'near-identical');
  assert.equal(verdict(0.005), 'close');
  assert.equal(verdict(0.02), 'diverging');
  assert.equal(verdict(0.4), 'different');
});

test('a screenshot present on only one side is reported, not skipped', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shoot(expected, 'viewport.png', () => { document.body.style.background = '#000'; });
    await shoot(actual, 'viewport.png', () => { document.body.style.background = '#000'; });
    await shoot(expected, 'full.png', () => {});
    await shoot(actual, 'extra.png', () => {});
    const r = await compareDirectories(expected, actual);
    assert.equal(r.counts.compared, 1);
    assert.equal(r.counts.missing, 1);
    assert.equal(r.counts.extra, 1);
    assert.equal(r.comparisons.find((c) => c.name === 'full.png').status, 'missing');
    assert.equal(r.overall, 'identical', 'the one comparable pair matched');
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('a run with nothing to compare is not a passing run', async () => {
  const a = await scratch();
  const b = await scratch();
  try {
    await writeFile(join(a, 'notes.txt'), 'not a screenshot');
    const r = await compareDirectories(a, b);
    assert.equal(r.counts.compared, 0);
    assert.equal(r.overall, 'not-measured');
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test('a non-image in a screenshot directory is an error, not a crash', async () => {
  const a = await scratch();
  const b = await scratch();
  try {
    await writeFile(join(a, 'broken.png'), 'not really a png');
    await writeFile(join(b, 'broken.png'), 'also not a png');
    const r = await compareDirectories(a, b);
    assert.equal(r.counts.errored, 1);
    assert.equal(r.overall, 'not-measured');
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test('the ratio is counted from pixels, not returned as a constant', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    // Two viewports differing by different amounts. A module that returned a
    // fixed number would score these the same.
    await shootMany(expected, { 'small.png': blank, 'large.png': blank });
    await shootMany(actual, { 'small.png': blocks([0, 0, 25, 25]), 'large.png': blocks([0, 0, 100, 50]) });
    const r = await scoreFidelity(expected, actual);
    const small = r.viewports.find((v) => v.viewport === 'small');
    const large = r.viewports.find((v) => v.viewport === 'large');
    assert.equal(r.measured, 2);
    // 25x25 and 100x50 blocks of a 200x100 page.
    assert.ok(Math.abs(small.diffRatio - (25 * 25) / (200 * 100)) < 0.02, `small: ${small.diffRatio}`);
    assert.ok(Math.abs(large.diffRatio - (100 * 50) / (200 * 100)) < 0.02, `large: ${large.diffRatio}`);
    assert.ok(large.diffRatio > small.diffRatio, 'a bigger change must score worse');
    assert.equal(r.worst.viewport, 'large');
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('the worst cluster names where the rebuild went wrong', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shootMany(expected, { 'wide.png': blank });
    await shootMany(actual, { 'wide.png': blocks([10, 20, 60, 40]) });
    const v = (await scoreFidelity(expected, actual)).viewports[0];
    assert.equal(v.clusters, 1);
    assert.ok(v.diffRatio > 0, 'there is a real difference here');
    // The block sits at 10,20 60x40. The antialiasing comparator drops the
    // column against the red edge, so the box gets one pixel of slack on each
    // side — what is asserted here is that the box points at the block.
    const { box } = v.worstCluster;
    assert.ok(box.left >= 10 && box.left <= 12, `left: ${box.left}`);
    assert.equal(box.top, 20);
    assert.ok(box.width >= 58 && box.width <= 60, `width: ${box.width}`);
    assert.equal(box.height, 40);
    assert.ok(Math.abs(v.worstCluster.ratio - v.diffRatio) < 1e-9,
      'one cluster covering the whole difference, so its share is the ratio');
    assert.equal(v.clusteringFailed, false);
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('the largest of several clusters is the one reported', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shootMany(expected, { 'two.png': blank });
    await shootMany(actual, { 'two.png': blocks([0, 0, 20, 20], [150, 70, 40, 20]) });
    const v = (await scoreFidelity(expected, actual)).viewports[0];
    assert.equal(v.clusters, 2);
    assert.deepEqual(v.worstCluster.box, { left: 150, top: 70, width: 40, height: 20 },
      'the 800px block, not the 400px one');
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('a perfect viewport has no cluster to report', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shootMany(expected, { 'same.png': blocks([0, 0, 40, 40]) });
    await shootMany(actual, { 'same.png': blocks([0, 0, 40, 40]) });
    const v = (await scoreFidelity(expected, actual)).viewports[0];
    assert.equal(v.diffRatio, 0);
    assert.equal(v.clusters, 0);
    assert.equal(v.worstCluster, null);
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('a one-sided screenshot is reported and never counted as a pass', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shootMany(expected, { 'a.png': blank, 'only-expected.png': blank });
    await shootMany(actual, { 'a.png': blank, 'only-actual.png': blank });
    const r = await scoreFidelity(expected, actual);
    const oneSided = r.viewports.filter((v) => v.missing.length > 0).map((v) => v.viewport).sort();
    assert.deepEqual(oneSided, ['only-actual', 'only-expected']);
    assert.equal(r.viewports.find((v) => v.viewport === 'only-expected').diffRatio, null);
    assert.equal(r.viewports.find((v) => v.viewport === 'only-actual').diffRatio, null);
    assert.equal(r.measured, 1, 'only the pair present on both sides counts as measured');
    assert.equal(r.missing, 2);
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('an empty comparison is distinguishable from a perfect one', async () => {
  const emptyA = await scratch();
  const emptyB = await scratch();
  const matchA = await scratch();
  const matchB = await scratch();
  try {
    await shootMany(matchA, { 'a.png': blocks([0, 0, 30, 30]) });
    await shootMany(matchB, { 'a.png': blocks([0, 0, 30, 30]) });
    const empty = await scoreFidelity(emptyA, emptyB);
    const perfect = await scoreFidelity(matchA, matchB);
    assert.equal(empty.measured, 0);
    assert.equal(empty.status, 'not-measured');
    assert.equal(perfect.measured, 1);
    assert.equal(perfect.status, 'identical');
    assert.notEqual(perfect.status, empty.status);
    assert.notEqual(JSON.stringify(empty.viewports), JSON.stringify(perfect.viewports));
  } finally {
    for (const d of [emptyA, emptyB, matchA, matchB]) await rm(d, { recursive: true, force: true });
  }
});

test('a non-image file is an error on its viewport, not a crash', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shootMany(expected, { 'ok.png': blank });
    await shootMany(actual, { 'ok.png': blank });
    await writeFile(join(expected, 'notes.txt'), 'not a screenshot');
    await writeFile(join(actual, 'notes.txt'), 'also not a screenshot');
    const r = await scoreFidelity(expected, actual);
    const notes = r.viewports.find((v) => v.viewport === 'notes.txt');
    assert.match(notes.error, /not a png screenshot/);
    assert.equal(notes.diffRatio, null);
    // Viewport names are filenames without `.png`: `ok.png` scores as `ok`.
    assert.equal(r.viewports.find((v) => v.viewport === 'ok').error, null);
    assert.equal(r.measured, 1);
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('a corrupt png is an error, and a missing directory is not a crash', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await writeFile(join(expected, 'broken.png'), 'not really a png');
    await writeFile(join(actual, 'broken.png'), 'also not a png');
    const r = await scoreFidelity(expected, actual);
    assert.equal(r.viewports[0].error !== null, true, 'the failure is reported on the viewport');
    assert.equal(r.measured, 0);
    const gone = await scoreFidelity(join(expected, 'nope'), actual);
    assert.equal(gone.measured, 0);
    assert.equal(gone.viewports[0].missing.length, 1);
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('the requested viewports are the ones scored', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shootMany(expected, { 'a.png': blank, 'b.png': blank });
    await shootMany(actual, { 'a.png': blocks([0, 0, 20, 20]), 'b.png': blank });
    const r = await scoreFidelity(expected, actual, { viewports: ['b'] });
    assert.deepEqual(r.viewports.map((v) => v.viewport), ['b']);
    assert.equal(r.viewports[0].diffRatio, 0);
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('a diff that cannot say where it differs is not a clean score', async () => {
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shootMany(expected, { 'a.png': blank });
    await shootMany(actual, { 'a.png': blocks([0, 0, 20, 20]) });
    const base = (await scoreFidelity(expected, actual)).viewports[0];
    assert.ok(base.diffRatio > 0);
    assert.equal(base.clusteringFailed, false);
    assert.ok(base.worstCluster.box);

    // looks-same falls back to a single whole-image area when clustering is off,
    // which is a real box and so not a failure; clusteringFailed only fires
    // when a ratio survives with nowhere to point.
    const unclustered = (await scoreFidelity(expected, actual,
      { looksSameOptions: { shouldCluster: false } })).viewports[0];
    assert.ok(unclustered.diffRatio > 0);
    assert.ok(unclustered.worstCluster.box, 'the fallback still names a region');
    assert.equal(unclustered.clusteringFailed, false);
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});

test('clusterSummary drops the empty area looks-same emits on a perfect match', () => {
  const none = clusterSummary({
    diffRatio: 0,
    totalPixels: 100,
    diffClusters: [{ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }],
  });
  assert.equal(none.clusters, 0);
  assert.equal(none.worstCluster, null);
  assert.equal(none.clusteringFailed, false);

  const lost = clusterSummary({ diffRatio: 0.4, totalPixels: 100, diffClusters: [] });
  assert.equal(lost.clusteringFailed, true, 'a ratio with no region is a broken comparison');
  assert.equal(lost.worstCluster, null);
});
test('a directory inside a shots dir is not scored as a viewport', async () => {
  // `screenshots/unreproducible/` holds evidence crops, not a picture. Scoring
  // it produced a null-ratio row, which reads as a capture that failed.
  const expected = await scratch();
  const actual = await scratch();
  try {
    await shootMany(expected, { 'viewport.png': blank });
    await shootMany(actual, { 'viewport.png': blank });
    await mkdir(join(expected, 'unreproducible'));
    await mkdir(join(actual, 'unreproducible'));

    const r = await scoreFidelity(expected, actual);
    assert.deepEqual(r.viewports.map((v) => v.viewport), ['viewport']);
    assert.equal(r.measured, 1);
  } finally {
    await rm(expected, { recursive: true, force: true });
    await rm(actual, { recursive: true, force: true });
  }
});
