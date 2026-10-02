import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchChecked, relativeFrom, treeResolver } from '../request-intercept.mjs';
import { createCaptureStore } from '../capture-store.mjs';

// ---- fetchChecked: the redirect chain is the security boundary ----

function fakeResponse({ status, location, url, body = '' }) {
  return {
    status: () => status,
    url: () => url,
    headers: () => (location ? { location } : {}),
    body: async () => Buffer.from(body),
    dispose: async () => {},
  };
}

const PUBLIC = { resolver: async () => ({ address: '93.184.216.34' }) };

function fakeHarness(hopResponses) {
  const fetched = [];
  let i = 0;
  return {
    fetched,
    route: { fetch: async (o) => { fetched.push(o.url); return hopResponses[i++]; } },
    context: { request: { fetch: async (url, o) => { fetched.push(url); return hopResponses[i++]; } } },
  };
}

test('a redirect into link-local is refused before it is requested', async () => {
  const h = fakeHarness([
    fakeResponse({ status: 302, location: 'http://169.254.169.254/latest/meta-data/', url: 'https://x.test/' }),
  ]);
  await assert.rejects(
    () => fetchChecked(h.context, h.route, 'https://x.test/', { allowPrivate: false, resolver: PUBLIC.resolver }),
    /169\.254\.169\.254/,
  );
  assert.deepEqual(h.fetched, ['https://x.test/'], 'the redirect target must never be requested');
});

test('a redirect into loopback is refused before it is requested', async () => {
  const h = fakeHarness([fakeResponse({ status: 301, location: 'http://127.0.0.1:8080/admin', url: 'https://x.test/' })]);
  await assert.rejects(() => fetchChecked(h.context, h.route, 'https://x.test/', { allowPrivate: false, resolver: PUBLIC.resolver }), /private\/loopback/);
  assert.deepEqual(h.fetched, ['https://x.test/']);
});

test('a disallowed scheme in a redirect target is refused', async () => {
  const h = fakeHarness([fakeResponse({ status: 302, location: 'file:///etc/passwd', url: 'https://x.test/' })]);
  await assert.rejects(() => fetchChecked(h.context, h.route, 'https://x.test/', { allowPrivate: false, resolver: PUBLIC.resolver }), /disallowed URL scheme/);
  assert.deepEqual(h.fetched, ['https://x.test/']);
});

test('a safe redirect is followed and both hops come back', async () => {
  const h = fakeHarness([
    fakeResponse({ status: 302, location: 'https://cdn.test/a.css', url: 'https://x.test/a.css' }),
    fakeResponse({ status: 200, url: 'https://cdn.test/a.css', body: 'body{}' }),
  ]);
  const { response, hops } = await fetchChecked(h.context, h.route, 'https://x.test/a.css', { allowPrivate: false, resolver: PUBLIC.resolver });
  assert.equal(response.status(), 200);
  assert.deepEqual(hops, [{ from: 'https://x.test/a.css', to: 'https://cdn.test/a.css', status: 302 }]);
});

test('a relative Location is resolved against the URL it came from', async () => {
  const h = fakeHarness([
    fakeResponse({ status: 302, location: '../b.css', url: 'https://x.test/a/a.css' }),
    fakeResponse({ status: 200, url: 'https://x.test/a/../b.css' }),
  ]);
  const { hops } = await fetchChecked(h.context, h.route, 'https://x.test/a/a.css', { allowPrivate: false, resolver: PUBLIC.resolver });
  assert.equal(hops[0].to, 'https://x.test/b.css');
});

test('a 302 downgrades POST to GET, a 308 keeps it', async () => {
  const h302 = fakeHarness([
    fakeResponse({ status: 302, location: 'https://x.test/b', url: 'https://x.test/a' }),
    fakeResponse({ status: 200, url: 'https://x.test/b' }),
  ]);
  await fetchChecked(h302.context, h302.route, 'https://x.test/a', { allowPrivate: false, method: 'POST', resolver: PUBLIC.resolver });
  assert.deepEqual(h302.fetched, ['https://x.test/a', 'https://x.test/b']);

  const h308 = fakeHarness([
    fakeResponse({ status: 308, location: 'https://x.test/b', url: 'https://x.test/a' }),
    fakeResponse({ status: 200, url: 'https://x.test/b' }),
  ]);
  await fetchChecked(h308.context, h308.route, 'https://x.test/a', { allowPrivate: false, method: 'POST', resolver: PUBLIC.resolver });
  assert.equal(h308.fetched.length, 2, 'the 308 hop is still fetched');
});

test('a redirect loop is capped instead of running forever', async () => {
  const hop = (n) => fakeResponse({ status: 302, location: `https://x.test/${n + 1}`, url: `https://x.test/${n}` });
  const h = fakeHarness(Array.from({ length: 12 }, (_, i) => hop(i)));
  await assert.rejects(() => fetchChecked(h.context, h.route, 'https://x.test/0', { allowPrivate: false, resolver: PUBLIC.resolver }), /more than 5 redirects/);
});

test('allowPrivate relaxes the address check but not the scheme check', async () => {
  const h = fakeHarness([
    fakeResponse({ status: 302, location: 'http://169.254.169.254/x', url: 'https://x.test/' }),
    fakeResponse({ status: 200, url: 'http://169.254.169.254/x' }),
  ]);
  const ok = await fetchChecked(h.context, h.route, 'https://x.test/', { allowPrivate: true, resolver: PUBLIC.resolver });
  assert.equal(ok.response.status(), 200, 'with allowPrivate the address is permitted');

  const h2 = fakeHarness([fakeResponse({ status: 302, location: 'file:///etc/passwd', url: 'https://x.test/' })]);
  await assert.rejects(() => fetchChecked(h2.context, h2.route, 'https://x.test/', { allowPrivate: true, resolver: PUBLIC.resolver }), /disallowed URL scheme/);
});

// ---- tree addressing ----

test('a sibling file resolves to its bare name', () => {
  assert.equal(relativeFrom('x.test/a/index.html', 'x.test/a/style.css'), 'style.css');
});

test('a file one level up needs exactly one up-step', () => {
  assert.equal(relativeFrom('x.test/a/b/index.html', 'x.test/a/style.css'), '../style.css');
});

test('a document beside its asset needs no up-step', () => {
  assert.equal(relativeFrom('x.test/index.html', 'x.test/index.html'), 'index.html');
});

test('a deeply nested document reaches a sibling directory', () => {
  assert.equal(relativeFrom('x.test/a/b/c/index.html', 'x.test/a/b/c/d/e.png'), 'd/e.png');
});

test('a cross-origin asset is reached through its own host directory', () => {
  assert.equal(relativeFrom('x.test/index.html', 'cdn.test/i.png'), '../cdn.test/i.png');
});

test('treeResolver returns null for an uncaptured URL', () => {
  const s = createCaptureStore();
  assert.equal(treeResolver(s, { docUrl: 'https://x.test/' })('https://x.test/nope.png'), null);
});

test('treeResolver returns null when the document itself was not captured', () => {
  const s = createCaptureStore();
  assert.equal(treeResolver(s, { docUrl: 'https://x.test/' })('https://x.test/a.css'), null);
});

test('treeResolver maps a captured URL to its path relative to the document', () => {
  const s = createCaptureStore();
  const put = (url, type) => s.put(
    { url: () => url, method: () => 'GET', resourceType: () => type, isNavigationRequest: () => type === 'document' },
    { url: () => url, status: () => 200, headers: () => ({ 'content-type': 'text/plain' }) },
    Buffer.from('x'),
  );
  put('https://x.test/', 'document');
  put('https://x.test/a.css', 'stylesheet');
  put('https://cdn.test/i.png', 'image');
  const resolve = treeResolver(s, { docUrl: 'https://x.test/' });
  assert.equal(resolve('https://x.test/a.css'), 'a.css');
  // Namespaced under the document's own host directory, so the reference never
  // climbs above the directory the tree is served as the root of.
  assert.equal(resolve('https://cdn.test/i.png'), '__external__/cdn.test/i.png');
});
