import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { finalize, installStyleSampler, collectMotion, SAMPLER_SOURCE } from '../motion-sampler.mjs';

// The production path: install before the navigation, so the animation that
// runs during load is already finished by the time anything is read back.
async function withLoad(html, fn, samplerOptions) {
  const dir = await mkdtemp(join(tmpdir(), 'de-sampler-'));
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installStyleSampler(page, samplerOptions);
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  try { await page.goto('http://localhost/'); return await fn(page, dir); }
  finally { await browser.close(); await rm(dir, { recursive: true, force: true }); }
}

const track = (stops, extra = {}) => ({ selector: '.a', tag: 'div', frames: stops.length, stops, ...extra });

test('a stop that changes nothing is dropped', () => {
  const { tracks } = finalize({
    frameCount: 3,
    tracks: [track([
      { t: 1, transform: 'none', opacity: '1', inlineStyle: {} },
      { t: 2, transform: 'none', opacity: '1', inlineStyle: {} },
      { t: 3, transform: 'matrix(1,0,0,1,10,0)', opacity: '1', inlineStyle: { transform: 'matrix(1,0,0,1,10,0)' } },
    ])],
  });
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].stops.length, 2, 'the repeated frame is not motion');
});

test('a track that never moved is not motion at all', () => {
  const { tracks } = finalize({
    frameCount: 2,
    tracks: [track([
      { t: 1, transform: 'none', opacity: '1', inlineStyle: {} },
      { t: 2, transform: 'none', opacity: '1', inlineStyle: {} },
    ])],
  });
  assert.deepEqual(tracks, []);
});

test('offsets are normalised to start at zero', () => {
  const { tracks } = finalize({
    frameCount: 100,
    tracks: [track([
      { t: 40, transform: 'none', opacity: '1', inlineStyle: {} },
      { t: 90, transform: 'matrix(1,0,0,1,5,0)', opacity: '1', inlineStyle: {} },
    ])],
  }, { ms: 2000 });
  assert.equal(tracks[0].stops[0].offset, 0);
  assert.equal(tracks[0].stops[1].offset, 0.5);
});

test('a long track is capped and marked truncated, keeping both ends', () => {
  const stops = Array.from({ length: 200 }, (_, i) => ({ t: i + 1, transform: `matrix(1,0,0,1,${i},0)`, opacity: '1', inlineStyle: {} }));
  const { tracks, truncated } = finalize({ frameCount: 200, tracks: [track(stops)] });
  assert.equal(tracks[0].stops.length, 24);
  assert.equal(tracks[0].stops[0].transform, 'matrix(1,0,0,1,0,0)', 'the first stop survives');
  assert.equal(tracks[0].stops[23].transform, 'matrix(1,0,0,1,199,0)', 'the last stop survives');
  assert.equal(tracks[0].truncated, true);
  assert.equal(truncated, false, 'a per-track cap is not a global truncation');
});

test('the sampler flags truncation when it ran out of frames', () => {
  assert.equal(finalize({ frameCount: 3000, truncated: true, tracks: [] }).truncated, true);
});

test('tracks are ordered by how much they moved', () => {
  const busy = track(Array.from({ length: 5 }, (_, i) => ({ t: i + 1, transform: `x${i}`, opacity: '1', inlineStyle: {} })), { selector: '.busy' });
  const calm = track(Array.from({ length: 2 }, (_, i) => ({ t: i + 1, transform: `y${i}`, opacity: '1', inlineStyle: {} })), { selector: '.calm' });
  const { tracks } = finalize({ frameCount: 5, tracks: [calm, busy] });
  assert.deepEqual(tracks.map((t) => t.selector), ['.busy', '.calm']);
});

test('every track is labelled as observed, not reconstructed', () => {
  const { tracks } = finalize({ frameCount: 2, tracks: [track([
    { t: 1, transform: 'none', opacity: '1', inlineStyle: {} },
    { t: 2, transform: 'matrix(1,0,0,1,1,0)', opacity: '1', inlineStyle: {} },
  ])] });
  assert.equal(tracks[0].fidelity, 'observed');
  assert.equal(tracks[0].driver, 'imperative');
});

const TYPING_PAGE = `<body><p id="t" style="display:inline"></p><script>
  const t = document.getElementById('t');
  const chars = ['H', 'e', 'l', 'l', 'o'];
  chars.forEach((c, i) => setTimeout(() => {
    const s = document.createElement('span');
    s.style.display = 'inline';
    s.textContent = c;
    t.appendChild(s);
  }, 30 * (i + 1)));
</script></body>`;

test('a typing animation that runs during load is recorded, character by character', async () => {
  // Two bugs meet here. A typing animation appends spans, so transform and
  // opacity never change and a transform-only signature collapsed every
  // character into one entry that was then filtered out as noise. And the whole
  // effect is over within 150ms of load, so a sampler installed after the page
  // settled never saw any of it — the clone came back with the text missing.
  await withLoad(TYPING_PAGE, async (page) => {
    await page.waitForTimeout(400);
    const { tracks } = await collectMotion(page);
    const t = tracks.find((x) => x.selector === '#t');
    assert.ok(t, 'the typing parent was tracked');
    assert.equal(t.motion, 'content');
    const typed = t.stops.filter((s) => s.kind === 'content');
    assert.deepEqual(typed.map((s) => s.text), ['H', 'He', 'Hel', 'Hell', 'Hello']);
    assert.deepEqual(typed.map((s) => s.length), [1, 2, 3, 4, 5]);
    assert.deepEqual(typed.map((s) => s.source), Array(5).fill('text-mutation'));
  });
});

test("a page's initial DOM build is not mistaken for motion", async () => {
  // Every element's children are inserted exactly once at first paint. Counting
  // that would spend the whole track budget on hydration noise and leave nothing
  // for the animation that actually happens afterwards.
  const body = `<body><div id="root"></div><script>
    const root = document.getElementById('root');
    for (let i = 0; i < 300; i++) {
      const d = document.createElement('div');
      d.className = 'row-' + i;
      d.appendChild(document.createElement('span'));
      root.appendChild(d);
    }
  </script></body>`;
  await withLoad(body, async (page) => {
    await page.waitForTimeout(300);
    const { tracks } = await collectMotion(page);
    assert.equal(tracks.length, 0, 'a one-shot build produced no motion tracks');
  });
});

test('a style tween is still recorded as a style tween', async () => {
  const body = `<body><div id="b"></div><script>
    const b = document.getElementById('b');
    for (let i = 0; i <= 8; i++) setTimeout(() => { b.style.transform = 'translateX(' + i * 10 + 'px)'; }, 30 * (i + 1));
  </script></body>`;
  await withLoad(body, async (page) => {
    await page.waitForTimeout(400);
    const { tracks } = await collectMotion(page);
    const b = tracks.find((x) => x.selector === '#b');
    assert.ok(b, 'the tween element was tracked');
    assert.equal(b.motion, 'style');
    assert.ok(b.stops.length > 2, 'the tween was not collapsed into one stop');
  });
});

test('the sampler reports no tracks on a page it never saw load', async () => {
  // A navigation that fails or a page that never runs the init script must not
  // take the whole capture down with it.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const result = await collectMotion(page);
    assert.deepEqual(result.tracks, []);
    assert.equal(result.frameCount, 0);
  } finally { await browser.close(); }
});

test('the sampler reads computed style only for elements whose inline style changed', async () => {
  // Reading it per frame per element would force a style recalc across the whole
  // page on every frame and make the sampler change what it is measuring.
  const computedReads = SAMPLER_SOURCE.match(/getComputedStyle/g) || [];
  assert.equal(computedReads.length, 1, 'one read per changed element, not one per frame per node');
});

// The shape tailwindcss.com actually ships. Its hero types ` p-7` into a <code>
// nested inside another <code> inside <span class="line">, so the characters
// land on an element several levels below the one whose text the reader sees.
// Requiring a candidate to have grown its own childNodes rejected all of these:
// on the live page the line's text grew 331 -> 459 chars across six mutations
// while its childNodes stayed at 14 throughout, and the sampler reported zero
// content tracks for a page built entirely out of text animations.
const NESTED_TYPING_PAGE = `<body><span class="line"><code><code id="t" style="display:inline"></code></code></span><script>
  const t = document.getElementById('t');
  [' p', '-', '7'].forEach((w, i) => setTimeout(() => {
    const s = document.createElement('span');
    s.textContent = w;
    t.appendChild(s);
  }, 40 * (i + 1)));
</script></body>`;

test('a reveal into a nested element is recorded even when the outer text never changes shape', async () => {
  await withLoad(NESTED_TYPING_PAGE, async (page) => {
    await page.waitForTimeout(400);
    const { tracks } = await collectMotion(page);
    const t = tracks.find((x) => x.selector === '#t');
    assert.ok(t, 'the nested element that received the characters was tracked');
    assert.equal(t.motion, 'content');
    const typed = t.stops.filter((s) => s.kind === 'content');
    // The sampler reports whitespace-normalised text: the text is what
    // identifies a stop, so it is collapsed the same way on every read.
    assert.deepEqual(typed.map((s) => s.text), ['p', 'p-', 'p-7']);
  });
});

test('a reveal that rewrites one text node in place is recorded', async () => {
  // characterData was not observed at all, and the guard at the top of the
  // observer callback dropped every record whose target was not an element,
  // which is every characterData record by definition. A typewriter that
  // writes into a text node instead of appending spans was doubly invisible.
  const body = `<body><p id="t" style="display:inline"></p><script>
    const t = document.getElementById('t');
    t.appendChild(document.createTextNode(''));
    const node = t.firstChild;
    ['a', 'ab', 'abc'].forEach((w, i) => setTimeout(() => { node.data = w; }, 40 * (i + 1)));
  </script></body>`;
  await withLoad(body, async (page) => {
    await page.waitForTimeout(400);
    const { tracks } = await collectMotion(page);
    const t = tracks.find((x) => x.selector === '#t');
    assert.ok(t, 'the element holding the rewritten text node was tracked');
    const typed = t.stops.filter((s) => s.kind === 'content');
    // The first stop is the state before the first keystroke, which is what a
    // replayer needs in order to know what it is replacing.
    assert.deepEqual(typed.map((s) => s.text), ['', 'a', 'ab', 'abc']);
  });
});

test('a document streamed in through script payloads is not mistaken for a reveal', async () => {
  // A server-rendered page appends its hydration payload to <body>. On
  // tailwindcss.com that grew body by 400-460KB across 19 records inside
  // 400ms. Counting it spends the track budget on the page arriving.
  const body = `<body><script>
    for (let i = 0; i < 12; i++) {
      const s = document.createElement('script');
      s.textContent = 'self.__payload=' + 'x'.repeat(20000) + ';';
      document.body.appendChild(s);
    }
    const p = document.createElement('p');
    p.id = 'late';
    p.textContent = 'arrived';
    document.body.appendChild(p);
  </script></body>`;
  await withLoad(body, async (page) => {
    await page.waitForTimeout(300);
    const { tracks } = await collectMotion(page);
    const selectors = tracks.map((x) => x.selector);
    assert.ok(!selectors.includes('body'), 'body did not become a track');
    assert.ok(!selectors.some((s) => s === 'script'), 'a streamed script payload did not become a track');
  });
});

// --target scoping. The page drives both subtrees identically, so an unscoped
// run records both. Asserting that the in-scope element survived would pass
// with no filter installed at all; the exclusion is the half that fails when
// the scope gate is missing.
const TWO_SUBTREE_PAGE = `<body><div id="card-a"><div id="in"></div></div><div id="card-b"><div id="out"></div></div><script>
  for (const id of ['in', 'out']) {
    const el = document.getElementById(id);
    for (let i = 0; i <= 8; i++) setTimeout(() => { el.style.transform = 'translateX(' + i * 10 + 'px)'; }, 30 * (i + 1));
  }
</script></body>`;

test('--target scoping keeps the targeted subtree and drops motion outside it', async () => {
  await withLoad(TWO_SUBTREE_PAGE, async (page) => {
    await page.waitForTimeout(400);
    const { tracks } = await collectMotion(page);
    const selectors = tracks.map((x) => x.selector);
    assert.ok(selectors.includes('#in'), 'the element inside the target was tracked');
    assert.ok(!selectors.includes('#out'), 'the element outside the target became a track');
  }, { scope: ['#card-a'] });
});

/**
 * A page with nothing moving on it. Non-interference is only decidable against
 * a still page: on one that animates, any difference between the two runs could
 * be the animation rather than the observer.
 */
const STILL_PAGE = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px system-ui; background: #f8fafc; }
  .card { width: 220px; margin: 24px; padding: 20px; border-radius: 12px;
          background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / .12); }
  .swatch { width: 48px; height: 48px; border-radius: 8px; background: #6366f1; }
  #late { opacity: .5; transform: rotate(3deg); }
</style></head><body>
  <div class="card"><div class="swatch"></div><p id="late">still</p></div>
</body></html>`;

/** Everything a screenshot or a consumer could notice, read back off the page. */
const READ_PAGE = `() => ({
  html: document.documentElement.outerHTML,
  styles: [...document.querySelectorAll('*')].map((el) => {
    const s = getComputedStyle(el);
    return [el.tagName, s.width, s.height, s.backgroundColor, s.color, s.opacity, s.transform, s.boxShadow].join('|');
  }),
})`;

async function shootAndRead(browser, sampler) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    if (sampler) await installStyleSampler(page);
    await page.setContent(STILL_PAGE);
    await page.waitForTimeout(250);
    const png = await page.screenshot({ fullPage: true });
    const read = await page.evaluate('('+READ_PAGE+')()');
    return { png, read };
  } finally {
    await page.close();
  }
}

test('the observer leaves no trace on the page it is measuring', async () => {
  const browser = await chromium.launch();
  try {
    const bare = await shootAndRead(browser, false);
    const sampled = await shootAndRead(browser, true);

    assert.equal(sampled.read.html, bare.read.html,
      'the sampler added, removed or rewrote a node');
    assert.deepEqual(sampled.read.styles, bare.read.styles,
      'the sampler changed what the page renders');
    assert.equal(sampled.png.equals(bare.png), true,
      'byte-identical rendering: a pixel difference is the only failure that matters here');
  } finally {
    await browser.close();
  }
});
