import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAttempt, runOptionalPasses } from '../optional-passes.mjs';

const OFF = { url: 'https://x.test/', timeout: 5, targets: [], allowPrivate: false };

async function harness(t, args) {
  const outDir = await mkdtemp(join(tmpdir(), 'de-opts-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const partials = [];
  const logged = [];
  // Stands in for `fileMeta`: reports what is on disk, so a pass that never
  // wrote its file cannot claim an artifact for it.
  const fileMeta = async (p) => {
    if (!existsSync(p)) throw new Error(`no such file: ${p}`);
    return { path: p, size: (await readFile(p)).length };
  };
  const err = (m) => logged.push(m);
  return {
    context: {}, page: {}, browser: {}, outDir, args, screenshotDir: join(outDir, 'screenshots'),
    fileMeta, dim: () => {}, err, partials, logged, attempt: createAttempt(partials, err),
  };
}

test('a pass that cannot run is recorded and does not take the capture with it', async (t) => {
  // The rule this module exists for. Run bare, a sweep that threw propagated out
  // of main(), which skipped the manifest write: the artifacts sorting before it
  // survived, everything after it was lost, and nothing recorded why.
  const h = await harness(t, { ...OFF, states: false, interactions: false, hover: false, sweep: true });
  const boom = { newContext: () => { throw new Error('browser.newContext is not a function'); } };

  const result = await runOptionalPasses({ ...h, browser: boom });

  assert.deepEqual(h.partials, [{ pass: 'sweep', error: 'browser.newContext is not a function' }]);
  assert.deepEqual(result.artifacts, [], 'a pass that produced nothing claims nothing');
  assert.equal(h.logged.length, 1);
  assert.match(h.logged[0], /^sweep pass failed: .* - continuing/);
});

test('a multi-line failure is recorded as one line, not a stack trace', async (t) => {
  const h = await harness(t, { ...OFF, states: false, interactions: false, hover: false, sweep: true });
  const boom = { newContext: () => { throw new Error('first line\n    at foo (x.js:1)'); } };

  await runOptionalPasses({ ...h, browser: boom });

  assert.equal(h.partials[0].error, 'first line');
});

test('a pass that never ran leaves no file claiming it found nothing', async (t) => {
  // states.json must not exist. An empty one reads as "this page has no
  // interactive elements", a different and far more confident claim than "the
  // state pass never finished".
  const h = await harness(t, { ...OFF, states: true, interactions: false, hover: false, sweep: false });
  h.attempt = async (label) => { h.partials.push({ pass: label, error: 'nope' }); return null; };

  const result = await runOptionalPasses(h);

  assert.equal(existsSync(join(h.outDir, 'states.json')), false);
  assert.deepEqual(result.artifacts, []);
});

test('a pass that ran and found nothing is not a failure', async (t) => {
  // The honest-empty case. A page with no hover states is a real finding and the
  // `[]` is its evidence, so the file has to exist for anyone to see that.
  // The pass is answered at the boundary this module owns - what it does with a
  // result of `[]`, as opposed to a pass that never returned.
  const h = await harness(t, { ...OFF, hover: true, states: false, sweep: false, interactions: false });
  h.attempt = async (label) => (label === 'hover' ? [] : null);

  const result = await runOptionalPasses(h);

  assert.deepEqual(result.hovers, []);
  assert.deepEqual(h.partials, [], 'an empty result is a finding, not a failure');
  assert.equal(existsSync(join(h.outDir, 'hover.json')), true, 'and it still produces the file');
});

test('a disabled pass writes nothing and reports no failure', async (t) => {
  const h = await harness(t, { ...OFF, states: false, sweep: false, interactions: false, hover: false });

  const result = await runOptionalPasses(h);

  assert.deepEqual(result, { artifacts: [], interactions: [], hovers: [] });
  assert.deepEqual(h.partials, []);
  assert.equal(existsSync(join(h.outDir, 'states.json')), false);
});

test('every failing pass is recorded, and reaching the last one proves none aborted', async (t) => {
  const h = await harness(t, { ...OFF, states: true, hover: true, sweep: true, interactions: false });
  const boom = { newContext: () => { throw new Error('no browser'); } };

  await runOptionalPasses({ ...h, browser: boom });

  // hover and states both need a page this harness does not have, and sweep needs
  // a browser. All three fail; none stops the next from being attempted, and each
  // is named in the order it was reached.
  assert.deepEqual(h.partials.map((p) => p.pass), ['hover', 'states', 'sweep']);
});
