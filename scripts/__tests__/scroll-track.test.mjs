import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { sampleScrollTrack } from '../scroll-track.mjs';

// A page with three things the track has to tell apart: a panel that fades in
// as it is scrolled to, a still element that must never be reported, and a
// second fading panel outside the scoped subtree.
const HTML = `<!doctype html><html><body style="margin:0">
  <style>
    body { margin: 0 }
    .panel { height: 90vh; background: #eee; }
    /* Offset and invisible until the observer brings it in. */
    .inner { opacity: 0; transform: translateY(60px) scale(0.95);
             transition: opacity 120ms linear, transform 120ms ease; }
    .panel.shown .inner { opacity: 1; transform: none; }
    /* Never changes at any scroll position. */
    #still { height: 200px; background: #333; }
  </style>
  <div id="keep"><div class="panel" id="p1"><div class="inner" id="i1">one</div></div></div>
  <div id="still">still</div>
  <div class="panel" id="p2"><div class="inner" id="i2">two</div></div>
  <div class="panel" id="p3"><div class="inner" id="i3">three</div></div>
  <div style="height:60vh"></div>
  <script>
    const io = new IntersectionObserver((rows) => {
      for (const r of rows) if (r.isIntersecting) r.target.classList.add('shown');
    }, { threshold: 0.15 });
    for (const p of document.querySelectorAll('.panel')) io.observe(p);
  </script>
</body></html>`;

let browser;
let page;

before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

// One page per run: the panels are shown by an observer on the first scroll, so
// a second run over the same page has no transition left to observe and would
// report nothing for reasons that have nothing to do with the test.
const freshPage = async () => {
  const p = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await p.setContent(HTML);
  await p.waitForTimeout(150);
  return p;
};
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.setContent(HTML);
  await page.waitForTimeout(150);
});

test('a panel that fades in on scroll is reported with the value it started from', async () => {
  const track = await sampleScrollTrack(page, { steps: 6, settleMs: 80 });
  const entries = track.flatMap((s) => s.entries);
  const fade = entries.filter((e) => e.selector === '#i2' || e.selector === '#i3');

  assert.ok(fade.length > 0, 'the panels that scroll into view must be reported');
  for (const e of fade) {
    assert.equal(e.from.opacity, '0', 'the from value is the pre-transition opacity');
    assert.match(e.from.transform, /translateY\(60px\)/, 'the from transform is the offset one');
    assert.equal(e.opacity, '1', 'the walk waits for the transition to land');
  }
});

test('an element that never moves is never reported', async () => {
  const track = await sampleScrollTrack(page, { steps: 6, settleMs: 80 });
  const entries = track.flatMap((s) => s.entries);

  assert.equal(entries.filter((e) => e.selector === '#still').length, 0,
    'a static element is not a scroll-linked mover');
});

test('each mover is reported once, not once per stop it is still moving', async () => {
  const track = await sampleScrollTrack(page, { steps: 6, settleMs: 80 });
  const selectors = track.flatMap((s) => s.entries.map((e) => e.selector));

  assert.equal(new Set(selectors).size, selectors.length,
    'a settled transition must not file the same element at every later stop');
});

test('the first stop is a baseline and reports nothing', async () => {
  const track = await sampleScrollTrack(page, { steps: 4, settleMs: 80 });

  assert.equal(track[0].scrollY, 0);
  assert.deepEqual(track[0].entries, [],
    'stop zero records where everything started, not what changed');
});

test('scope keeps out panels outside the targeted subtree', async () => {
  const a = await freshPage();
  const b = await freshPage();
  const scoped = await sampleScrollTrack(a, { steps: 6, settleMs: 80, scope: ['#keep'] });
  const unscoped = await sampleScrollTrack(b, { steps: 6, settleMs: 80 });
  const names = (track) => track.flatMap((s) => s.entries.map((e) => e.selector));

  assert.equal(names(scoped).filter((s) => s === '#i2' || s === '#i3').length, 0,
    'a panel outside --target must not be reported');
  assert.ok(names(unscoped).includes('#i2') || names(unscoped).includes('#i3'),
    'the same page unscoped does report them, so the filter is what removed them');
  await a.close();
  await b.close();
});

test('the page is left where it was found', async () => {
  const before = await page.evaluate(() => window.scrollY);
  await sampleScrollTrack(page, { steps: 6, settleMs: 80 });
  const after = await page.evaluate(() => window.scrollY);

  assert.equal(after, before, 'the scroll pass screenshots the page, so it must not find it scrolled');
});
