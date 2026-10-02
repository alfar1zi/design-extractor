import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { runFidelityPass } from '../fidelity-pass.mjs';
import { createAttempt } from '../optional-passes.mjs';

// One browser for the whole file: a diff between shots from different builds or
// scale factors measures the environment, not the rebuild.
let browser;
after(async () => { if (browser) await browser.close(); });

const BLUE = '<body style="background:#0af"></body>';
const WHITE = '<body style="background:#fff"></body>';

async function shot(dir, name, html) {
  if (!browser) browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 120, height: 60 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html);
    await page.screenshot({ path: join(dir, name) });
  } finally {
    await page.close();
  }
}

async function harness(t, { reference = BLUE } = {}) {
  const outDir = await mkdtemp(join(tmpdir(), 'de-fidelity-pass-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const screenshotDir = join(outDir, 'screenshots');
  const refDir = join(outDir, 'reference');
  await mkdir(screenshotDir, { recursive: true });
  await mkdir(refDir, { recursive: true });
  await shot(screenshotDir, 'viewport.png', BLUE);
  if (reference) await shot(refDir, 'viewport.png', reference);

  const partials = [];
  const errs = [];
  const dim = [];
  return {
    partials,
    errs,
    dim,
    input: {
      args: { fidelity: refDir, viewport: '120x60' },
      outDir,
      screenshotDir,
      unreproducibleItems: [],
      attempt: createAttempt(partials, (m) => errs.push(m)),
      // The real fileMeta reports size 0 for a missing file. `stat` throws
      // instead, so a pass claiming an artifact it never wrote fails loudly.
      fileMeta: async (p) => ({ path: p, size: (await stat(p)).size }),
      dim: (m) => dim.push(m),
    },
    fidelityJson: () => readFile(join(outDir, 'fidelity.json'), 'utf8').then(JSON.parse),
  };
}

test('a missing reference directory is reported as not-measured, never as a pass', async (t) => {
  const h = await harness(t);
  await rm(join(h.input.outDir, 'reference'), { recursive: true, force: true });

  const artifact = await runFidelityPass(h.input);
  const scored = await h.fidelityJson();

  // The lie this module exists to prevent: shots exist on one side only, and a
  // run that compared nothing reporting `identical` or `diffRatio: 0`.
  assert.equal(scored.status, 'not-measured');
  assert.equal(scored.measured, 0);
  assert.equal(scored.worst, null);
  for (const v of scored.viewports) assert.equal(v.diffRatio, null, 'an uncompared viewport has no ratio');
  assert.deepEqual(scored.viewports.map((v) => v.missing.map((m) => m.missingFrom)), [['expected']],
    'the side that has no shots is named');
  assert.match(h.dim.join('\n'), /Fidelity: not-measured across 0 viewport\(s\)/);
  assert.match(h.dim.join('\n'), /nothing was compared/);

  // Still an artifact: the score was written, and it records what did not happen.
  assert.equal(artifact.path, join(h.input.outDir, 'fidelity.json'));
  assert.ok(artifact.size > 0);
  assert.deepEqual(h.partials, [], 'an absent reference directory is a result, not a crash');
});

test('a reference path that is not a directory is surfaced and claims no artifact', async (t) => {
  const h = await harness(t);
  const notADir = join(h.input.outDir, 'a-file.png');
  await writeFile(notADir, 'not a directory');

  const artifact = await runFidelityPass({ ...h.input, args: { ...h.input.args, fidelity: notADir } });

  assert.equal(artifact, null, 'nothing was written, so nothing is claimed');
  assert.deepEqual(h.partials.map((p) => [p.pass, /ENOTDIR/.test(p.error)]), [['fidelity', true]]);
  assert.match(h.errs.join('\n'), /fidelity pass failed: .*ENOTDIR/);
  assert.deepEqual(h.dim, [], 'a run that scored nothing reports no fidelity line');
  await assert.rejects(() => h.fidelityJson(), /ENOENT/);
});

test('a score that throws propagates to a caller that does not swallow it', async (t) => {
  const h = await harness(t);
  // This run's own screenshot directory is unreadable: the scoring call raises,
  // so a pass that guarded around it would be hiding the reason the run has no
  // score at all.
  const notADir = join(h.input.outDir, 'shots.png');
  await writeFile(notADir, 'not a directory');

  await assert.rejects(
    () => runFidelityPass({ ...h.input, screenshotDir: notADir, attempt: (label, fn) => fn() }),
    /ENOTDIR/,
  );
  await assert.rejects(() => h.fidelityJson(), /ENOENT/);
});

test('a comparison that matched reports an explicit zero over one measured viewport', async (t) => {
  const h = await harness(t, { reference: BLUE });

  await runFidelityPass(h.input);
  const scored = await h.fidelityJson();

  // `measured` is what separates this from the missing-directory run: a genuine
  // perfect run and a run that compared nothing must not look alike.
  assert.equal(scored.status, 'identical');
  assert.equal(scored.measured, 1);
  assert.equal(scored.missing, 0);
  assert.deepEqual(scored.worst, { viewport: 'viewport', diffRatio: 0 });
  assert.equal(scored.viewports[0].diffRatio, 0);
  assert.equal(scored.viewports[0].missing.length, 0);
  assert.match(h.dim.join('\n'), /Fidelity: identical across 1 viewport\(s\), worst viewport at 0\.000% of pixels/);
});

test('a comparison that differs names the viewport it disagreed on', async (t) => {
  const h = await harness(t, { reference: WHITE });

  await runFidelityPass(h.input);
  const scored = await h.fidelityJson();

  assert.equal(scored.status, 'different');
  assert.equal(scored.measured, 1);
  assert.equal(scored.worst.viewport, 'viewport');
  assert.ok(scored.worst.diffRatio > 0.5, `expected white vs blue, got ratio ${scored.worst.diffRatio}`);
  assert.match(h.dim.join('\n'), /Fidelity: different across 1 viewport\(s\), worst viewport at \d+\.\d{3}% of pixels/);
});

test('the reference directory is the expected side and this run\'s shots are the actual side', async (t) => {
  const h = await harness(t);
  await runFidelityPass(h.input);

  const scored = await h.fidelityJson();
  assert.equal(scored.expectedDir, h.input.args.fidelity);
  assert.equal(scored.actualDir, h.input.screenshotDir);
  assert.equal(scored.viewports[0].viewport, 'viewport');
});

test('the score runs under the fidelity label, and findings may be absent', async (t) => {
  const h = await harness(t);
  const labels = [];

  const artifact = await runFidelityPass({
    ...h.input,
    unreproducibleItems: undefined,
    attempt: async (label, fn) => { labels.push(label); return fn(); },
  });

  assert.deepEqual(labels, ['fidelity']);
  assert.ok(artifact.size > 0, 'no findings is not a reason to score nothing');
});

test('an element the capture could not rebuild is reported on the viewport it was seen in', async (t) => {
  // This field exists so a low ratio is not read as "matched" when part of the
  // original was a video nobody can rebuild from a capture. It was carried but
  // keyed by CSS selector, while the score reads it per screenshot stem, so the
  // lookup never matched and every finding vanished.
  const h = await harness(t, { reference: WHITE });

  await runFidelityPass({
    ...h.input,
    unreproducibleItems: [
      { selector: '.hero video', reason: 'video', screenshot: 'video-0.png' },
      { selector: '.hero canvas', reason: 'webgl', screenshot: 'webgl-1.png' },
    ],
  });
  const scored = await h.fidelityJson();

  assert.deepEqual(scored.viewports[0].unreproducible.map((e) => [e.selector, e.reason]),
    [['.hero video', 'video'], ['.hero canvas', 'webgl']],
    'both findings reach the viewport they were observed in');
});