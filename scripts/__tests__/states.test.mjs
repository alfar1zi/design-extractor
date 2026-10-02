import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { settleMs, diffStyles, stateEntry, readStyles, readTiming, measuredTiming } from '../states.mjs';
import { openCdp } from '../cdp.mjs';

test('a transition list settles on its slowest member, not its first', () => {
  // `transition: opacity .3s, transform .5s` is 500ms, not 300ms.
  const ms = settleMs({ 'transition-duration': '0.3s, 0.5s', 'transition-delay': '0s' });
  assert.equal(ms, 500);
});

test('a delay is added to its own duration, not to the whole list', () => {
  const ms = settleMs({ 'transition-duration': '0.2s, 0.1s', 'transition-delay': '0.4s, 0s' });
  assert.equal(ms, 600, 'the slow one is 0.2s+0.4s; the fast one is 0.1s+0s');
});

test('a single shared delay applies to every member', () => {
  assert.equal(settleMs({ 'transition-duration': '0.2s, 0.1s', 'transition-delay': '0.3s' }), 500);
});

test('ms and s units are both read', () => {
  assert.equal(settleMs({ 'transition-duration': '300ms, 0.2s' }), 300);
});

test('a running animation means the element has not settled yet', () => {
  const ms = settleMs({ 'transition-duration': '0s', 'transition-delay': '0s', 'animation-duration': '1.5s' });
  assert.equal(ms, 1500);
});

test('a page with no timing at all settles immediately, not never', () => {
  assert.equal(settleMs({}), 0);
  assert.equal(settleMs({ 'transition-duration': 'normal', 'transition-delay': 'normal' }), 0);
});

test('only the properties that changed are reported', () => {
  const changed = diffStyles({ color: 'red', width: '10px' }, { color: 'blue', width: '10px' });
  assert.deepEqual(changed, { color: { from: 'red', to: 'blue' } });
});

test('a real capture carries a measured duration', () => {
  const entry = stateEntry({
    selector: '.btn', state: ':hover', mode: 'real', observed: 300, timing: 300,
    before: { color: 'white' }, after: { color: 'black' },
  });
  assert.equal(entry.timing, 300);
  assert.equal(entry.timingSource, 'measured', 'the number came off a running animation');
  assert.equal(entry.changedCount, 1);
  assert.equal(entry.note, undefined, 'a measured capture needs no caveat');
});

test('a real capture with nothing running says the number was declared, not observed', () => {
  // The honest case. Nothing was animating, so `timing` is whatever the CSS
  // declares - which is the clock the pass slept on, not a duration anyone
  // watched. Reporting it unqualified is how a consumer rebuilds a curve that
  // was never measured.
  const entry = stateEntry({
    selector: '.btn', state: ':hover', mode: 'real', timing: 300,
    before: { color: 'white' }, after: { color: 'black' },
  });
  assert.equal(entry.timing, 300, 'the declared value is still reported');
  assert.equal(entry.timingSource, 'declared');
  assert.match(entry.note, /declared CSS value, not an observed duration/);
});

test('a forced state reports the duration it actually animated for', () => {
  // Measured, not assumed: forcing :hover on a transitioning element leaves a
  // live CSSTransition in Blink whose duration is the declared one. Reporting
  // 'unverified' here would discard a measurement we actually took.
  const entry = stateEntry({
    selector: '.btn', state: ':hover', mode: 'forced', observed: 400,
    before: { color: 'white' }, after: { color: 'black' },
  });
  assert.equal(entry.timing, 400);
  assert.match(entry.note, /measured from the running animation/);
  assert.equal(entry.changedCount, 1, 'the style diff is still real');
});

test('a forced state with nothing animating refuses to claim a duration', () => {
  // The declared transition-duration is still readable here, and reporting it
  // would be exactly the fabrication this guard exists to prevent.
  const entry = stateEntry({
    selector: '.btn', state: ':hover', mode: 'forced', timing: 300,
    before: { color: 'white' }, after: { color: 'black' },
  });
  assert.equal(entry.timing, 'unverified', 'a declared duration is not an observed one');
  assert.match(entry.note, /no animation was running/);
});

test('a state that changes nothing is still reported as changing nothing', () => {
  const entry = stateEntry({
    selector: '.btn', state: ':focus', mode: 'real', timing: 0,
    before: { color: 'red' }, after: { color: 'red' },
  });
  assert.equal(entry.changedCount, 0);
  assert.deepEqual(entry.changed, {});
});

test('a live hover is measured for real, with the timing the user sees', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        #btn { color: rgb(255,0,0); transition: color 0.25s ease, transform 0.75s ease; }
        #btn:hover { color: rgb(0,0,255); }
      </style>
      <button id="btn">go</button>`);
    const handle = await page.$('#btn');
    const before = await readStyles(handle);
    await page.hover('#btn');
    // The old code read only the first duration and settled at 250ms, capturing
    // the element mid-flight on the 750ms transform.
    const transitionMs = settleMs(await readTiming(handle));
    await page.waitForTimeout(transitionMs);
    const after = await readStyles(handle);

    assert.equal(transitionMs, 750, 'the slower of the two transitions decides');
    assert.equal(diffStyles(before, after).color.to, 'rgb(0, 0, 255)');
  } finally {
    await browser.close();
  }
});

test('a forced pseudo-state really does animate, so its duration is measurable', async () => {
  // The assumption this replaces: forcing a pseudo-state applies the CSS without
  // running the transition, so its duration is unknowable. Measured against this
  // Chromium, a forced :hover leaves a live CSSTransition running for the full
  // declared duration, and getComputedStyle walks a continuous ramp to the end
  // colour rather than snapping to it. This fails if that stops being true.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        #b { background-color: rgb(255,0,0); transition: background-color 400ms linear; }
        #b:hover { background-color: rgb(0,0,255); }
      </style>
      <div id="b">x</div>`);
    const cdp = await openCdp(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#b' });
    const handle = await page.$('#b');

    try {
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      const running = await measuredTiming(handle);
      assert.equal(running.length, 1, 'forcing the state started a transition');
      assert.equal(running[0].duration, 400, 'it runs for the declared duration');
      // Still mid-flight on read. A value that had already snapped to the end
      // would prove the transition never actually started.
      const during = await readStyles(handle);
      assert.notEqual(during['background-color'], 'rgb(0, 0, 255)', 'it has not jumped to the end');
    } finally {
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    }
  } finally {
    await browser.close();
  }
});
