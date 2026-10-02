import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installCanvasRecorder, detectCanvas } from '../canvas-detect.mjs';
import { findUnreproducible } from '../unreproducible-pass.mjs';

// One of every kind the pass is meant to tell apart, plus two things it must not
// report: a bare div and a div the page has not drawn into yet.
const HTML = `<!doctype html><html><body style="margin:0">
  <canvas id="flat" width="120" height="60"></canvas>
  <canvas id="gpu" width="120" height="60"></canvas>
  <video id="v" width="120" height="60" muted></video>
  <iframe id="fr" width="120" height="60" src="https://example.com/e"></iframe>
  <section id="wrap"><div class="card" id="gate">Please sign in to continue</div>
    <canvas id="inside" width="120" height="60"></canvas></section>
  <div id="empty" style="height:120px"></div>
  <button id="draw">draw</button>
  <script>
    document.getElementById('inside').getContext('2d');
    const f = document.getElementById('flat').getContext('2d');
    f.fillStyle = '#4f46e5'; f.fillRect(0, 0, 120, 60);
    const g = document.getElementById('gpu').getContext('webgl');
    g.clearColor(0.9, 0.2, 0.2, 1); g.clear(g.COLOR_BUFFER_BIT);
  </script>
</body></html>`;

let browser;
let page;
let dir;

// A real navigation, not setContent: an init script only runs for navigations,
// and the recorder is an init script. setContent would leave every canvas with
// an unknown type and the test would be measuring the fallback.
const open = async (p, html) => {
  await p.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await p.waitForTimeout(100);
};

before(async () => {
  browser = await chromium.launch();
  dir = await mkdtemp(path.join(tmpdir(), 'de-unrep-'));
});
after(async () => { await browser?.close(); });
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  // The recorder has to be in place before the first navigation; that is the
  // whole reason it exists rather than a probe.
  await installCanvasRecorder(page);
  await open(page, HTML);
});

test('the two canvases are told apart by the context the page gave them', async () => {
  const found = await findUnreproducible(page, { screenshots: false });
  const by = (sel) => found.items.find((i) => i.selector === sel);

  assert.equal(by('#flat').reason, 'canvas2d', 'a 2d context is not a WebGL canvas');
  assert.equal(by('#gpu').reason, 'webgl', 'a webgl context must not be filed as 2d');
});

test('detecting a canvas does not stop the page drawing into it', async () => {
  await findUnreproducible(page, { screenshots: false });

  // A detection that asked for a context would have locked this canvas to that
  // type, and the page's own 2d draw would come back null and draw nothing.
  const drawn = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 10; c.height = 10;
    document.body.append(c);
    const ctx = c.getContext('2d');
    if (!ctx) return 'no-context';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 10, 10);
    return ctx.getImageData(0, 0, 1, 1).data.join(',');
  });

  assert.equal(drawn, '0,0,0,255', 'the page can still take the context it asked for');
});

test('video and iframe are reported with the detail needed to act on them', async () => {
  const found = await findUnreproducible(page, { screenshots: false });
  const by = (sel) => found.items.find((i) => i.selector === sel);

  assert.equal(by('#v').reason, 'video');
  assert.equal(by('#fr').reason, 'iframe');
  assert.equal(by('#fr').crossOrigin, true, 'a cross-origin iframe is the case that needs saying');
});

test('a sign-in block with no form behind it is flagged, a bare div is not', async () => {
  const found = await findUnreproducible(page, { screenshots: false });
  const by = (sel) => found.items.find((i) => i.selector === sel);

  assert.equal(by('#gate').reason, 'auth-gated');
  assert.equal(by('#empty'), undefined, 'a div with no paint and no text is not a finding');
});

test('a wrapper around a sign-in prompt is not itself a second finding', async () => {
  const found = await findUnreproducible(page, { screenshots: false });
  const gates = found.items.filter((i) => i.reason === 'auth-gated');

  // Every ancestor of the prompt contains the same words. Flagging them too
  // claimed the whole section was gated and photographed the same region twice.
  assert.deepEqual(gates.map((g) => g.selector), ['#gate']);
});

test('every entry carries the box a rebuild has to reproduce', async () => {
  const found = await findUnreproducible(page, { screenshots: false });

  assert.ok(found.count > 0);
  for (const item of found.items) {
    assert.ok(item.selector && item.reason, 'each entry names what and why');
    assert.ok(item.box.width > 0 && item.box.height > 0,
      `${item.selector} was given a real box, not an empty one`);
  }
});

test('scope keeps out elements outside the targeted subtree', async () => {
  const p = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await installCanvasRecorder(p);
  await open(p, `<!doctype html><body><div id="keep"><canvas id="a" width="60" height="30"></canvas></div>
    <canvas id="b" width="60" height="30"></canvas>
    <script>document.getElementById('a').getContext('2d');document.getElementById('b').getContext('2d');</script></body>`);
  const found = await findUnreproducible(p, { screenshots: false, scope: ['#keep'] });
  const names = found.items.map((i) => i.selector);

  assert.ok(names.includes('#a'));
  assert.equal(names.includes('#b'), false, 'a canvas outside --target is out of scope');
  await p.close();
});

test('detectCanvas reports the recorded context without asking for one', async () => {
  const info = await detectCanvas(page);
  const flat = info.find((c) => c.id === 'flat');
  const gpu = info.find((c) => c.id === 'gpu');

  assert.equal(flat.hasWebGL, false);
  assert.equal(gpu.hasWebGL, true);
  assert.equal(flat.contextKnown, true, 'the recorder was installed, so the type is known not guessed');
});

test('each finding is photographed so it can be matched against', async () => {
  const { mkdir } = await import('node:fs/promises');
  const shotDir = path.join(dir, String(Date.now()));
  await mkdir(path.join(shotDir, 'unreproducible'), { recursive: true });

  const found = await findUnreproducible(page, { shotDir });
  const shot = found.items.find((i) => i.screenshot);
  for (const item of found.items) {
    assert.ok(item.screenshot, `${item.selector} got a screenshot, not a silent null`);
  }
  assert.ok(shot, 'the finding with a screenshot is named');

  const { readFile, readdir } = await import('node:fs/promises');
  const shotFiles = path.join(shotDir, 'unreproducible');
  const files = await readdir(shotFiles);
  assert.equal(files.length, found.count, 'every finding is photographed, not just one');

  for (const item of found.items) {
    const buf = await readFile(path.join(shotFiles, item.screenshot));
    assert.equal(buf.subarray(1, 4).toString(), 'PNG', `${item.screenshot} is a PNG`);
    // The clip has to be the element, so the image is the size the scan recorded.
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, item.box.width, `${item.selector} shot is the width that was scanned`);
    assert.equal(height, item.box.height, `${item.selector} shot is the height that was scanned`);
  }
});

// A stylesheet on another port is another origin to the browser, which is the
// whole point: the same host at a second port is what makes `cssRules` throw
// without reaching outside the machine.
const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

test('a stylesheet the browser refuses to expose is reported, and a readable one is not', async () => {
  // `unproducible.complete` is what the docs tell consumers to trust before
  // promising a 1:1 rebuild. When the rules of a stylesheet were never read,
  // that field has to be false — and nothing set it before.
  const css = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('body { color: red }');
  });
  await new Promise((r) => css.listen(0, '127.0.0.1', r));
  const foreign = `http://127.0.0.1:${css.address().port}/theme.css`;

  const p = await browser.newPage();
  try {
    await p.route('**/theme.css', (route) => route.fulfill({
      status: 200, contentType: 'text/css', body: 'body { color: rebeccapurple }',
    }));
    // Served by a route handler, so the request goes to the page's own origin —
    // the sheet is readable, and must not be reported.
    await p.route('**/local.css', (route) => route.fulfill({
      status: 200, contentType: 'text/css', body: 'body { margin: 0 }',
    }));
    await p.goto('data:text/html,'
      + `<link rel="stylesheet" href="${foreign}">`
      + '<link rel="stylesheet" href="/local.css"><p>hi</p>');
    await p.waitForTimeout(150);

    const found = await findUnreproducible(p, { screenshots: false });
    assert.ok(found.crossOriginSheets.includes(foreign),
      `the blocked sheet was not reported: ${JSON.stringify(found.crossOriginSheets)}`);
    assert.ok(!found.crossOriginSheets.some((h) => h.includes('local.css')),
      `a readable sheet was reported as blocked: ${JSON.stringify(found.crossOriginSheets)}`);
  } finally {
    await p.close();
    await new Promise((r) => css.close(r));
  }
});

test('a page with no external stylesheet reports none', async () => {
  // The negative control. Without it, an assertion that some sheet is listed
  // would also hold if the scan reported every sheet, blocked or not.
  const found = await findUnreproducible(page, { screenshots: false });
  assert.deepEqual(found.crossOriginSheets, [],
    `a data: URL page has no cross-origin sheets: ${JSON.stringify(found.crossOriginSheets)}`);
});
