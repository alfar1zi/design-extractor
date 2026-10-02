// settle.test.mjs - the two ways a capture can end before it is really done.
//
// The bug this guards: a page can hold a steady DOM and a finished
// `readyState` while responses are still streaming in. That is the normal state
// of a server-rendered app between "document parsed" and "framework module
// script ran": the markup is complete and stable, and the route chunks it is
// about to import are still arriving. Settling on DOM shape alone ended those
// captures early, so the tree was written without them and the capture reported
// nothing missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { waitForSettle } from '../dom-probe.mjs';
import { createCaptureStore } from '../capture-store.mjs';
import { installInterceptor } from '../request-intercept.mjs';

const CHUNKS = 8;
const GAP_MS = 180;

/**
 * A page that never changes its DOM but streams CHUNKS responses after load.
 * The document is stable from the first poll; only the network says otherwise.
 */
function startServer() {
  const server = createServer((req, res) => {
    if (req.url.startsWith('/chunk')) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(`/* ${req.url} */`);
      return;
    }
    const script = Array.from({ length: CHUNKS }, (_, i) => `setTimeout(() => fetch('/chunk${i}'), ${i * GAP_MS});`).join('');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>settle</title><body><p>static</p><script>${script}</script>`);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function settleOn(server, { network }) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const store = createCaptureStore();
  await installInterceptor(context, store, { allowPrivate: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const result = await waitForSettle(page, { network: network && ((ms) => store.quietFor(ms)) });
  const captured = store.captureStats().entries.filter((e) => e.url.includes('/chunk')).length;
  await browser.close();
  return { captured, elapsedMs: result.elapsedMs };
}

test('DOM-only settle returns while responses are still arriving', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { captured } = await settleOn(server, { network: false });

  // The failure the fix removes: the page looked finished, and the capture kept
  // only the chunks that had landed inside the stable window.
  assert.ok(captured < CHUNKS, `expected the DOM-only settle to truncate, but it captured all ${captured}`);
});

test('settling on the network too captures every response', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const { captured } = await settleOn(server, { network: true });

  assert.equal(captured, CHUNKS);
});

test('a request with no response is reported, not silently dropped', () => {
  const store = createCaptureStore();
  const req = { isNavigationRequest: () => false, resourceType: () => 'script' };

  store.noteRequest('http://x/landed.js');
  store.put(req, fakeResponse('http://x/landed.js'), Buffer.from('x'));
  // Issued, then torn down before anything came back. `missing` cannot hold it:
  // no response was ever seen to fail.
  store.noteRequest('http://x/dangling.js');

  const stats = store.captureStats();
  assert.equal(stats.missing.length, 0);
  assert.deepEqual(stats.uncaptured, [{ url: 'http://x/dangling.js', reason: 'no-response' }]);
});

function fakeResponse(url) {
  return {
    url: () => url,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/javascript' }),
  };
}
