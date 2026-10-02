import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { componentPass, collectShapes } from '../components-pass.mjs';

// Two sections of repeated cards, so a --target run has a subtree to keep and a
// subtree it must drop. Without the second section, "scope restricts the output"
// would be indistinguishable from "the page only had that in it".
const HTML = `<!doctype html><html><body>
  <section id="pricing" class="grid">
    <article class="card"><h3>Pro</h3></article>
    <article class="card"><h3>Team</h3></article>
    <article class="card"><h3>Solo</h3></article>
  </section>
  <section id="faq" class="grid">
    <article class="panel"><h3>Refunds</h3></article>
    <article class="panel"><h3>Support</h3></article>
  </section>
</body></html>`;

/** Every key reachable in a JSON document, at any depth. */
function allKeys(value, acc = new Set()) {
  if (Array.isArray(value)) { for (const v of value) allKeys(v, acc); return acc; }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) { acc.add(k); allKeys(value[k], acc); }
  }
  return acc;
}

let browser;
let dirs;

before(async () => {
  browser = await chromium.launch();
  dirs = 0;
});

after(async () => {
  await browser?.close();
});

/** Run the pass into its own directory and hand back what landed there. */
async function run(html = HTML, opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), `de-compass-${dirs++}-`));
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    const counts = await componentPass(page, dir, opts);
    const entries = await readdir(dir);
    const read = (f) => readFile(path.join(dir, f), 'utf8').then(JSON.parse).catch(() => null);
    return {
      counts,
      entries: entries.sort(),
      authoritative: await read('components.authoritative.json'),
      inferred: await read('components.inferred.json'),
      dir,
    };
  } finally {
    await page.close();
  }
}

/**
 * Mount a framework handle by hand. The probe reads Vue's production app handle,
 * which is a plain object, so the shape can be built here without loading Vue
 * from a CDN: a component boundary is a vnode whose type is an object, and that
 * is what the file under test consumes.
 */
const MOUNT_VUE = `(() => {
  const app = document.querySelector('#app');
  const cards = app.querySelectorAll('.card');
  app.__vue_app__ = { _container: { _vnode: {
    type: { __name: 'CardGrid' }, el: app.querySelector('.grid'),
    children: cards.length ? [
      { type: { __name: 'PricingCard' }, el: cards[0], props: { tier: 'pro' } },
      { type: { __name: 'PricingCard' }, el: cards[1], props: { tier: 'team' } },
    ] : [],
  } } };
})()`;

const VUE_HTML = `<!doctype html><html><body><div id="app">
  <section id="pricing" class="grid">
    <article class="card"><h3>Pro</h3></article>
    <article class="card"><h3>Team</h3></article>
  </section>
</div></body></html>`;

async function runVue(opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), `de-compass-${dirs++}-`));
  const page = await browser.newPage();
  try {
    await page.setContent(VUE_HTML);
    await page.evaluate(MOUNT_VUE);
    const counts = await componentPass(page, dir, opts);
    const read = (f) => readFile(path.join(dir, f), 'utf8').then(JSON.parse).catch(() => null);
    return { counts, dir, authoritative: await read('components.authoritative.json'), inferred: await read('components.inferred.json') };
  } finally {
    await page.close();
  }
}

test('no guessed cluster is written under a component name', async () => {
  const { inferred } = await run();
  assert.ok(inferred.clusters.length >= 2, `both sections cluster: ${JSON.stringify(inferred.clusters.map((c) => c.signature))}`);

  // The whole point of the split: a cluster is a guess, and a field named `name`
  // is read as a fact by whatever consumes the artifact. Checked at every depth,
  // because a nested `name` is exactly as misleading as a top-level one.
  assert.equal(allKeys(inferred).has('name'), false,
    `inferred file carries a name field somewhere: ${JSON.stringify(inferred.clusters)}`);
  assert.equal(allKeys(inferred).has('componentName'), false);

  for (const c of inferred.clusters) {
    assert.equal(typeof c.clusterId, 'string', 'a cluster is identified by its shape, not by a name');
    assert.ok(Array.isArray(c.candidateLabels));
  }
  assert.equal(inferred.components, undefined, 'the inferred file carries no component list at all');
});

test('a page with no framework gets the inferred file and no authoritative file', async () => {
  const { entries, counts, authoritative, inferred } = await run();
  assert.deepEqual(entries, ['components.inferred.json']);
  // An empty list and an absent list mean different things: absent means "no
  // framework claimed anything", which is not the same as "none found".
  assert.equal(authoritative, null);
  assert.equal(counts.wroteAuthoritative, false);
  assert.equal(counts.named, 0);
  assert.equal(inferred.source, 'dom-clustering');
  assert.ok(inferred.shapesScanned > 0);
});

test('a framework-reported boundary lands in the authoritative file with its markup', async () => {
  const { authoritative, inferred, counts } = await runVue();
  assert.equal(authoritative.source, 'framework-reported');
  assert.equal(counts.wroteAuthoritative, true);
  assert.ok(counts.named >= 1, `the named boundary is counted: ${JSON.stringify(authoritative.components.map((c) => c.componentName))}`);

  const card = authoritative.components.find((c) => c.componentName === 'PricingCard');
  assert.ok(card, 'the framework name is reported as-is');
  assert.equal(card.named, true);
  assert.equal(card.captureConfidence, 'named');
  // A name is a lookup table; the rebuild needs the thing itself.
  assert.ok(card.markup && card.markup.includes('<article'), `markup travels with the entry: ${card.markup}`);
  // The entry must carry resolved styles, not just a name. Which properties get
  // resolved is component-detail.mjs's contract, not this pass's, so assert the
  // shape of what came back rather than a property name it is free to choose.
  assert.ok(card.computed && Object.keys(card.computed).length > 0,
    `resolved styles travel with the entry: ${JSON.stringify(card.computed)}`);
  assert.ok(Object.values(card.computed).every((v) => typeof v === 'string' && v.length),
    'every resolved property carries the value the page computed');
  assert.ok(Array.isArray(card.matchedRules), 'matched rules travel with it too');

  assert.equal(allKeys(inferred).has('componentName'), false,
    'the authoritative names must not leak into the file that holds guesses');
});

test('--target keeps the matched subtree and drops the rest', async () => {
  const scoped = await run(HTML, { scope: ['#pricing'] });
  const all = await run(HTML);
  assert.deepEqual(scoped.inferred.scope, ['#pricing']);
  assert.equal(all.inferred.scope, null, 'an unscoped run records null, not an empty scope');

  const scopedSigs = scoped.inferred.clusters.map((c) => c.signature);
  const allSigs = all.inferred.clusters.map((c) => c.signature);
  assert.ok(allSigs.includes('article::panel'), 'the unscoped run has both sections to confuse the scoped one with');
  assert.ok(scopedSigs.includes('article::card'));
  assert.equal(scopedSigs.includes('article::panel'), false, `the untargeted section survived: ${JSON.stringify(scopedSigs)}`);
  assert.equal(scopedSigs.length < allSigs.length, true);
});

test('maxNodes bounds the shape walk on a large page', async () => {
  const big = `<!doctype html><html><body>${'<article class="card">x</article>'.repeat(500)}</body></html>`;
  const page = await browser.newPage();
  try {
    await page.setContent(big);
    const capped = await collectShapes(page, { maxNodes: 7 });
    const uncapped = await collectShapes(page);
    assert.ok(uncapped.length > 400, `the page really is large: ${uncapped.length}`);
    assert.ok(capped.length > 0, 'the cap still walks the page');
    assert.equal(capped.length <= 7, true, `${capped.length} shapes from a 7-node budget`);
  } finally {
    await page.close();
  }
});

test('a cluster is one repeated shape, counted, not one entry per element', async () => {
  const { inferred } = await run(HTML, { scope: ['#pricing'] });
  assert.deepEqual(inferred.clusters.map((c) => [c.signature, c.count]), [['article::card', 3]]);
});

test('states and motion are attached to the component whose selector they name', async () => {
  const first = await runVue();
  const grid = first.authoritative.components.find((c) => c.componentName === 'CardGrid');
  assert.ok(grid, 'the grid boundary was found');

  const dir = await mkdtemp(path.join(tmpdir(), `de-compass-${dirs++}-`));
  await writeFile(path.join(dir, 'states.json'), JSON.stringify({
    states: [
      { selector: grid.hostSelector, state: ':hover', changed: { 'background-color': ['rgb(255,255,255)', 'rgb(0,0,0)'] } },
      { selector: '.never-rendered', state: ':hover', changed: { color: ['a', 'b'] } },
    ],
  }));
  const page = await browser.newPage();
  try {
    await page.setContent(VUE_HTML);
    await page.evaluate(MOUNT_VUE);
    const counts = await componentPass(page, dir, {
      motion: { sampled: [{ selector: grid.hostSelector, stops: [{ offset: 0, transform: 'none' }] }] },
    });
    const doc = JSON.parse(await readFile(path.join(dir, 'components.authoritative.json'), 'utf8'));

    const attached = doc.components.find((c) => c.componentName === 'CardGrid');
    assert.equal(attached.states.length, 1, 'the state naming this component is attached to it');
    assert.equal(attached.states[0].state, ':hover');
    assert.equal(attached.motion.length, 1);
    assert.equal(attached.motion[0].selector, grid.hostSelector);
    // Another component's state must not be borrowed by this one.
    assert.equal(doc.components.find((c) => c.componentName === 'PricingCard').states, undefined);
    assert.equal(doc.statesAttached, 1);
    assert.equal(doc.motionAttached, 1);
    assert.equal(counts.clusters >= 1, true);
  } finally {
    await page.close();
  }
});