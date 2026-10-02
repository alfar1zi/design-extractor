import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureStore } from '../capture-store.mjs';

// A request/response pair that agrees on its URL, the way Playwright's do.
function pair(url, { method = 'GET', resourceType = 'script', isNavigationRequest = false, status = 200, contentType = 'application/javascript' } = {}) {
  return {
    request: { url: () => url, method: () => method, resourceType: () => resourceType, isNavigationRequest: () => isNavigationRequest },
    response: { url: () => url, status: () => status, headers: () => ({ 'content-type': contentType }) },
  };
}

const put = (s, url, body, opts) => { const { request, response } = pair(url, opts); return s.put(request, response, body == null ? null : Buffer.from(body), opts); };

test('a captured response is retrievable by URL', () => {
  const s = createCaptureStore();
  put(s, 'https://x.test/a.js', 'abc');
  const hit = s.get('https://x.test/a.js');
  assert.equal(hit.body.toString(), 'abc');
  assert.equal(hit.status, 200);
  assert.equal(hit.contentType, 'application/javascript');
});

test('an uncaptured URL is a miss, not a throw', () => {
  const s = createCaptureStore();
  assert.equal(s.get('https://x.test/nope.js'), null);
});

test('a later response for the same URL replaces the earlier one', () => {
  const s = createCaptureStore();
  put(s, 'https://x.test/a.js', 'old');
  put(s, 'https://x.test/a.js', 'new');
  assert.equal(s.get('https://x.test/a.js').body.toString(), 'new');
  assert.equal(s.captureStats().bytes, 3, 'byte count must not double-count the replaced body');
});

test('a body over the per-body cap is recorded as missing, not stored', () => {
  const s = createCaptureStore({ maxBodyBytes: 4 });
  put(s, 'https://x.test/a.js', 'way too long');
  assert.equal(s.get('https://x.test/a.js'), null);
  assert.deepEqual(s.missing.map((m) => m.reason), ['body-too-large']);
  assert.equal(s.missing[0].url, 'https://x.test/a.js');
});

test('storing past the total cap stops capturing but keeps what was captured', () => {
  const s = createCaptureStore({ maxBytes: 8 });
  put(s, 'https://x.test/1.js', '12345');
  put(s, 'https://x.test/2.js', '12345');
  assert.ok(s.get('https://x.test/1.js'), 'earlier body survives');
  assert.equal(s.get('https://x.test/2.js'), null, 'later body is dropped at the cap');
  assert.ok(s.missing.some((m) => m.url === 'https://x.test/2.js' && m.reason === 'store-full'));
});

test('a redirect hop is recorded against the URL the browser asked for', () => {
  const s = createCaptureStore();
  s.noteRedirect('https://x.test/a.js', 'https://x.test/b.js', 302);
  assert.deepEqual(s.redirects, [{ from: 'https://x.test/a.js', to: 'https://x.test/b.js', status: 302 }]);
});

test('a failed body read is recorded instead of vanishing', () => {
  const s = createCaptureStore();
  const { request, response } = pair('https://x.test/a.js');
  s.putFailed(request, response, new Error('No resource with given identifier'));
  assert.equal(s.get('https://x.test/a.js'), null);
  assert.equal(s.missing[0].reason, 'body-unavailable');
  assert.match(s.missing[0].detail, /No resource with given identifier/);
});

test('a 304 carries no body and is not reported as a loss', () => {
  const s = createCaptureStore();
  put(s, 'https://x.test/a.js', null, { status: 304, contentType: '' });
  assert.equal(s.get('https://x.test/a.js').status, 304);
  assert.deepEqual(s.missing, []);
});

test('a document response gets an index.html tree path', () => {
  const s = createCaptureStore();
  put(s, 'https://x.test/', '<html>', { isNavigationRequest: true, contentType: 'text/html' });
  assert.equal(s.get('https://x.test/').rel, 'x.test/index.html');
});

test('captureStats counts entries and bytes', () => {
  const s = createCaptureStore();
  put(s, 'https://x.test/a.js', 'abc');
  put(s, 'https://x.test/b.css', 'de', { contentType: 'text/css' });
  const st = s.captureStats();
  assert.equal(st.entries.length, 2);
  assert.equal(st.bytes, 5);
  assert.equal(st.missing.length, 0);
});

test('captureStats never serializes the bodies', () => {
  const s = createCaptureStore();
  put(s, 'https://x.test/a.js', 'secret-bytes-here');
  assert.equal(JSON.stringify(s.captureStats()).includes('secret-bytes-here'), false);
});

test('entries are ordered by path so the manifest is diffable', () => {
  const s = createCaptureStore();
  put(s, 'https://x.test/z.js', '1');
  put(s, 'https://x.test/a.js', '1');
  assert.deepEqual(s.captureStats().entries.map((e) => e.rel), ['x.test/a.js', 'x.test/z.js']);
});

test('two distinct URLs that want the same path get distinct paths', () => {
  // / and /index.html both want x.test/index.html, but they are different resources.
  const s = createCaptureStore();
  put(s, 'https://x.test/', '1', { isNavigationRequest: true, contentType: 'text/html' });
  put(s, 'https://x.test/index.html', '2', { contentType: 'text/html' });
  const paths = s.captureStats().entries.map((e) => e.rel);
  assert.equal(new Set(paths).size, 2, `paths collided: ${paths}`);
  assert.ok(paths.includes('x.test/index.html'), paths.join(' '));
  assert.equal(s.get('https://x.test/').body.toString(), '1', 'the first claimant keeps the clean path');
});

test('the first document defines the origin a foreign asset is namespaced under', () => {
  const s = createCaptureStore();
  put(s, 'https://x.test/', '<html>', { isNavigationRequest: true, contentType: 'text/html' });
  put(s, 'https://cdn.test/i.png', 'png', { contentType: 'image/png' });
  assert.equal(s.get('https://cdn.test/i.png').rel, 'x.test/__external__/cdn.test/i.png');
  assert.equal(s.get('https://x.test/').rel, 'x.test/index.html');
});

test('an explicit origin wins over the document that arrives first', () => {
  const s = createCaptureStore({ origin: 'https://x.test/' });
  put(s, 'https://cdn.test/i.png', 'png', { contentType: 'image/png' });
  assert.equal(s.get('https://cdn.test/i.png').rel, 'x.test/__external__/cdn.test/i.png');
});
