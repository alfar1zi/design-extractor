import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statesPass } from '../states-pass.mjs';

// A page with a real multi-property transition, a focus target, a checkbox whose
// :checked state animates, a second checkbox whose :checked state does not, and
// one element that both transitions on hover and changes on focus.
const HTML = `<!doctype html><html><body style="font:16px sans-serif">
  <style>
    #buy { background-color: rgb(255,0,0); transition: background-color 300ms linear, transform 200ms ease; }
    #buy:hover { background-color: rgb(0,0,255); transform: translateX(8px); }
    #box { background: rgb(0,0,0); transition: background-color 150ms linear; }
    #box:focus { background: rgb(255,255,255); }
    #animated { transition: background-color 250ms linear; }
    #animated:checked { background-color: rgb(0,0,255); }
    /* The revert after the cursor leaves is itself animated, so a baseline read
       too early sees an interpolated colour and files the hover properties
       under ":focus". */
    #both:focus { outline: 3px solid rgb(16,185,129); }
    #both:hover { background-color: rgb(0,0,255); }

  </style>
  <button id="buy">Buy</button>
  <div id="box" tabindex="0">focus me</div>
  <input type="checkbox" id="animated">
  <input type="checkbox" id="plain">
  <button id="both">Both</button>
</body></html>`;

let browser;
let dir;

before(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), 'de-states-'));
});

after(async () => {
  await browser?.close();
});

/** Run the pass on a fresh page and return the parsed artifact. */
async function run(opts = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    await page.setContent(HTML);
    const counts = await statesPass(page, dir, { limit: 20, ...opts });
    const doc = JSON.parse(await readFile(path.join(dir, 'states.json'), 'utf8'));
    return { counts, doc, at: (sel, state) => doc.states.find((s) => s.selector === sel && s.state === state) };
  } finally {
    await page.close();
  }
}

test('the declared transition is reported per property, not collapsed to one number', async () => {
  const { at } = await run();
  assert.deepEqual(
    at('#buy', ':hover').transitions.map((t) => [t.property, t.duration, t.easing]),
    [['background-color', 300, 'linear'], ['transform', 200, 'ease']],
    'a page that transitions two properties differently needs both curves, not one settle time',
  );
});

test('a real hover is captured with the timing the user actually sees', async () => {
  const { at } = await run();
  const hover = at('#buy', ':hover');
  assert.equal(hover.mode, 'real');
  assert.equal(hover.timing, 300, 'settles on the slower of the two transitions');
  assert.deepEqual(Object.keys(hover.changed).sort(), ['background-color', 'transform']);
});

test('focus reaches a state a cursor cannot hover into', async () => {
  const { at } = await run();
  assert.equal(at('#box', ':focus').changed['background-color'].to, 'rgb(255, 255, 255)');
});

test('one state never borrows another states properties', async () => {
  const { at } = await run();
  const focus = at('#both', ':focus');
  assert.equal('background-color' in focus.changed, false,
    'the hover revert animates too, so a baseline sampled mid-revert reads an interpolated colour');
  assert.ok(focus.changed['outline-color'], 'the focus rule is still reported in full');
  assert.deepEqual(Object.keys(at('#both', ':hover').changed), ['background-color']);
});

test('a forced state is measured when it animates and refused when it does not', async () => {
  const { doc } = await run();
  const animated = doc.states.find((s) => s.selector === '#animated' && s.state === ':checked');
  const plain = doc.states.find((s) => s.selector === '#plain' && s.state === ':checked');
  assert.equal(animated.timing, 250, 'the forced transition really runs, so its duration is known');
  assert.equal(plain.timing, 'unverified', 'nothing animates here, so a duration would be invented');
});

test('forced :checked is never applied to something that cannot be checked', async () => {
  const { doc } = await run();
  assert.deepEqual(
    doc.states.filter((s) => s.state === ':checked').map((s) => s.selector).sort(),
    ['#animated', '#plain'],
    'forcing :checked onto a button matches no rule and invents a state change',
  );
});

test('an element with no such state is reported as changing nothing', async () => {
  const { at } = await run();
  assert.equal(at('#box', ':hover').changedCount, 0, 'no :hover rule means no change, and saying so is the point');
});

test('--target scopes the artifact and records the scope it ran under', async () => {
  const { doc } = await run({ scope: ['#box'] });
  assert.deepEqual(doc.scope, ['#box']);
  assert.deepEqual([...new Set(doc.states.map((s) => s.selector))], ['#box']);
});

test('an unscoped run records a null scope rather than an empty one', async () => {
  const { doc } = await run();
  assert.equal(doc.scope, null);
  assert.ok(doc.elementsMeasured > 3, 'the whole page is measured when nothing is targeted');
});
// The whole pass hangs on one belief: that Blink animates a forced pseudo-class
// the way it animates a real one. If it did not, every forced duration would be
// a declaration read back and quoted as if a user had sat through it.
//
// The fixture styles the measured element itself, not a sibling, so a change is
// only invisible if the force genuinely did not take effect.
const FORCED = `<!doctype html><html><body>
  <style>
    /* Non-round, unequal durations: a number that came from the running
       animation can be told from one read off the declaration. */
    #anim { appearance: none; width: 20px; height: 20px; background-color: rgb(226,232,240);
            transition: background-color 237ms linear, transform 419ms cubic-bezier(.2,.8,.2,1); }
    #anim:checked { background-color: rgb(22,163,74); transform: scale(1.08); }
    #already { appearance: none; width: 20px; height: 20px; background-color: rgb(203,213,225);
               transition: background-color 237ms linear; }
  </style>
  <input type="checkbox" id="anim">
  <input type="checkbox" id="already" checked>
</body></html>`;

async function runForced() {
  const page = await browser.newPage();
  try {
    await page.setContent(FORCED);
    await statesPass(page, dir, { limit: 10 });
    const doc = JSON.parse(await readFile(path.join(dir, 'states.json'), 'utf8'));
    return (id) => doc.states.find((s) => s.selector === id && s.state === ':checked');
  } finally {
    await page.close();
  }
}

test('a forced pseudo-class that changes the element is animated, and the duration is the real one', async () => {
  const at = await runForced();
  const forced = at('#anim');
  assert.equal(forced.mode, 'forced', 'no cursor reaches :checked, so it has to be forced');
  assert.equal(forced.changedCount, 2, 'the forced state really reached the element');
  assert.equal(forced.timingSource, 'measured',
    'a duration taken off the running animation, not off the declaration');
  assert.equal(forced.timing, 419,
    '419ms is the declared transform, and it is the longer of the two properties, so it is not the default 0');
  assert.equal(forced.timing, 419, 'and it is not the background 237ms: the longest transition wins');
});

test('forcing a state the element already has reports no timing rather than inventing one', async () => {
  const at = await runForced();
  const forced = at('#already');
  assert.equal(forced.mode, 'forced');
  assert.equal(forced.changedCount, 0, 'the element was already checked, so nothing changed');
  assert.equal(forced.timingSource, 'unverified');
  assert.equal(forced.timing, 'unverified',
    'a number here would be a declaration quoted as an observation');
});
