import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { installCanvasRecorder, detectCanvas } from '../canvas-detect.mjs';

// #painted is drawn by the page's own script, which asks for '2d' twice.
// #gl is given a WebGL context by the page.
// #lazy is not touched until it is clicked - the lazy-init pattern that a
// detection pass would break if it asked each canvas for a context itself.
const DRAW = `<!doctype html><meta charset="utf-8">
<style>body{margin:0}canvas{display:block}#lazy{width:100px;height:50px}</style>
<canvas id="painted" width="120" height="60"></canvas>
<canvas id="lazy" width="100" height="50"></canvas>
<canvas id="gl" width="80" height="40"></canvas>
<script>
  const painted = document.getElementById('painted');
  const ctx = painted.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 120, 60);
  painted.getContext('2d');
  document.getElementById('gl').getContext('webgl');
  document.getElementById('lazy').addEventListener('click', () => {
    const c = document.getElementById('lazy').getContext('2d');
    c.fillStyle = '#00ff00';
    c.fillRect(0, 0, 100, 50);
    window.__lateDrew = c.getImageData(1, 1, 1, 1).data[3];
  });
</script>`;

// #wide has layout size 120x30 but attribute size 300x900: the two must not be
// conflated, because unreproducible.mjs screenshots the box, not the backing
// store. #a.b needs CSS.escape to be addressable at all.
const META = `<!doctype html><meta charset="utf-8">
<style>body{margin:0}#wide{width:120px;height:30px}</style>
<canvas id="wide" width="300" height="900"></canvas>
<canvas id="a.b" class="tag one" width="10" height="10"></canvas>`;

const PLAIN = '<!doctype html><meta charset="utf-8"><p>nothing painted here</p>';

const PAGES = { '/draw': DRAW, '/meta': META, '/plain': PLAIN };

let server;
let origin;
let browser;

before(async () => {
  server = createServer((req, res) => {
    const html = PAGES[new URL(req.url, 'http://x').pathname];
    if (!html) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

/** Load one fixture page, optionally with the recorder installed first. */
async function open(path, { record = true } = {}) {
  const page = await browser.newPage();
  if (record) await installCanvasRecorder(page);
  await page.goto(origin + path, { waitUntil: 'load' });
  return page;
}

const byId = (found, id) => found.find((c) => c.id === id);

test('a page with no canvas reports the empty result rather than throwing', async () => {
  for (const record of [true, false]) {
    const page = await open('/plain', { record });
    try {
      assert.deepEqual(await detectCanvas(page), []);
    } finally {
      await page.close();
    }
  }
});

test('a canvas is WebGL only when the page was actually given a WebGL context', async () => {
  const page = await open('/draw');
  try {
    const found = await detectCanvas(page);
    assert.deepEqual(found.map((c) => c.id), ['painted', 'lazy', 'gl'],
      'every canvas is reported, in document order');

    const painted = byId(found, 'painted');
    assert.equal(painted.hasWebGL, false, 'a 2d canvas is not WebGL');
    assert.deepEqual(painted.contexts, ['2d'],
      'and the page asking for 2d twice records it once');
    assert.equal(painted.contextKnown, true);

    const gl = byId(found, 'gl');
    assert.equal(gl.hasWebGL, true, 'a canvas given webgl IS WebGL');
    assert.deepEqual(gl.contexts, ['webgl']);

    const lazy = byId(found, 'lazy');
    assert.equal(lazy.hasWebGL, false, 'a canvas nobody asked about is not WebGL');
    assert.deepEqual(lazy.contexts, [],
      'and asking about it did not hand it a context');
  } finally {
    await page.close();
  }
});

test('detecting a page does not stop that page from painting its own canvas', async () => {
  const page = await open('/draw');
  try {
    await detectCanvas(page);

    // The pixel the page drew before detection must still be there: detection
    // is a read, and a read does not clear a backing store.
    const stillRed = await page.evaluate(() => {
      const d = document.getElementById('painted').getContext('2d').getImageData(1, 1, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    });
    assert.deepEqual(stillRed, [255, 0, 0, 255],
      'the page keeps its own pixels after detection');

    // The real test of the fix: #lazy paints only when clicked. Had detection
    // asked it for a context, the type would be locked and this page's own
    // getContext('2d') would return null - the page breaks because it was looked at.
    await page.click('#lazy');
    assert.equal(await page.evaluate(() => window.__lateDrew), 255,
      "the page's own getContext('2d') still returned a working context");
  } finally {
    await page.close();
  }
});

test('each canvas reports its backing store, its layout box and an addressable selector', async () => {
  const page = await open('/meta');
  try {
    const found = await detectCanvas(page);
    const wide = byId(found, 'wide');
    assert.equal(wide.width, 300, 'the backing store is 300 wide');
    assert.equal(wide.height, 900);
    assert.deepEqual(wide.box, { x: 0, y: 0, width: 120, height: 30 },
      'but the box on screen is 120x30 - a screenshot crops by the box');

    assert.equal(byId(found, 'a.b').className, 'tag one');

    for (const c of found) {
      const roundTrip = await page.evaluate(
        (sel) => document.querySelector(sel)?.id ?? null, c.selector);
      assert.equal(roundTrip, c.id, `${c.selector} must resolve back to its canvas`);
    }
  } finally {
    await page.close();
  }
});

test('without the recorder a context type is reported as unknown, never guessed', async () => {
  const page = await open('/draw', { record: false });
  try {
    const found = await detectCanvas(page);
    assert.equal(found.length, 3, 'canvases are still listed without the recorder');
    const gl = byId(found, 'gl');
    assert.equal(gl.contextKnown, false, 'the type is unknown, not inferred');
    assert.deepEqual(gl.contexts, []);
    assert.equal(gl.hasWebGL, false,
      'a real WebGL canvas is not claimed as WebGL from no evidence at all');
  } finally {
    await page.close();
  }
});