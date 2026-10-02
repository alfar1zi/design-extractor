import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { interactionPass, hoverPass } from '../interaction-pass.mjs';

const HOME_URL = 'https://example.test/index.html';

// Three clickable elements, and the first one leaves the page. That is the case
// that decides whether the sweep can share one page: without a reload, the
// element at nth=1 after a navigation is whatever the new page happens to have.
const HOME = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
  <a id="away" href="https://example.test/elsewhere.html">Leave</a>
  <a href="#two">Second</a>
  <button id="third" style="transition:background .2s;background:#eee">Third</button>
  <style>#third:hover{background:#0f0}</style>
</body></html>`;
const ELSEWHERE = '<!doctype html><html><body><button>Unrelated</button><a>Other</a></body></html>';

let browser;
let dir;
let loads;

before(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), 'de-inter-'));
});
after(async () => { await browser?.close(); });

// The pass builds its own pages from the context, so the routes have to be on
// the context: a route set on a page this test opened would never see them.
const openContext = async () => {
  const context = await browser.newContext();
  loads = 0;
  await context.route('**/*', (route) => {
    if (route.request().resourceType() !== 'document') {
      return route.fulfill({ status: 404, body: '' });
    }
    loads++;
    const elsewhere = route.request().url().includes('elsewhere');
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: elsewhere ? ELSEWHERE : HOME,
    });
  });
  return context;
};

test('a click that navigates does not shift what the next index measures', async () => {
  const context = await openContext();
  const results = await interactionPass(context, HOME_URL, 10, dir);

  assert.equal(results[0].navigated, true, 'the first element leaves the page');
  assert.deepEqual(results.map((r) => r.name), ['Leave', 'Second', 'Third'],
    'each index still measured the element it named on the original page,'
      + ' not the two unrelated buttons on the page it landed on');
  await context.close();
});

test('each hover reports the timing of the element it pointed at', async () => {
  const context = await openContext();
  const results = await hoverPass(context, HOME_URL, 10, dir);

  assert.equal(results.length, 3);
  // The anchors declare nothing and the button declares 200ms. Reading the
  // timing after the hover, per element, is what keeps one element's declared
  // duration from being attributed to the next one on the shared page.
  assert.deepEqual(results.map((r) => r.transitionMs), [0, 0, 200]);
  for (const r of results) {
    assert.ok(r.beforeShot.endsWith('.png') && r.afterShot.endsWith('.png'),
      `element ${r.index} has its own before/after pair`);
    assert.notEqual(r.beforeShot, r.afterShot);
  }
  await context.close();
});

test('the sweep costs one load, not one per element', async () => {
  const context = await openContext();
  await hoverPass(context, HOME_URL, 10, dir);

  // One load to count the targets, then the single page the sweep runs on.
  assert.equal(loads, 2, `hovering three elements cost two loads, not four (got ${loads})`);
  await context.close();
});
