import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { urlToTreePath, extensionFor, assertSafeRel, refInsideHostDir } from '../url-tree.mjs';
import { relativeFrom } from '../request-intercept.mjs';

// The tree root every relative path must stay inside.
const ROOT = '/tmp/de-tree';

function assertInsideRoot(rel) {
  const abs = resolve(ROOT, rel);
  assert.ok(abs.startsWith(ROOT + sep) || abs === ROOT, `escaped root: ${rel}`);
}

test('extensionFor prefers content-type over the URL path', () => {
  assert.equal(extensionFor('https://x.test/a', { contentType: 'text/css; charset=utf-8' }), '.css');
  // Path says .css, server says JS: the server wins.
  assert.equal(extensionFor('https://x.test/a.css', { contentType: 'application/javascript' }), '.js');
});

test('extensionFor falls back to the path, then to .bin', () => {
  assert.equal(extensionFor('https://x.test/a/b/font.woff2'), '.woff2');
  assert.equal(extensionFor('https://x.test/api/users'), '.bin');
  assert.equal(extensionFor('https://x.test/stream', { contentType: 'text/event-stream' }), '.bin');
});

test('content-type without a subtype is not trusted', () => {
  assert.equal(extensionFor('https://x.test/a', { contentType: 'text' }), '.bin');
  assert.equal(extensionFor('https://x.test/a', { contentType: '' }), '.bin');
});

test('a query string never becomes a path segment', () => {
  const { rel } = urlToTreePath('https://x.test/static/app.css?v=2');
  assert.equal(rel.includes('?'), false);
  assert.equal(rel.includes('v=2'), false);
});

test('the same URL always maps to the same path', () => {
  const a = urlToTreePath('https://x.test/a/b.js');
  const b = urlToTreePath('https://x.test/a/b.js');
  assert.equal(a.rel, b.rel);
});

test('different query strings on one path get distinct paths', () => {
  const a = urlToTreePath('https://x.test/a.css?v=2');
  const b = urlToTreePath('https://x.test/a.css?v=3');
  assert.notEqual(a.rel, b.rel, 'v=2 and v=3 are different resources');
});

test('a fragment never becomes a path segment', () => {
  const { rel } = urlToTreePath('https://x.test/a.js#frag');
  assert.equal(rel.includes('#'), false);
});

test('unsafe characters are escaped away', () => {
  const { rel } = urlToTreePath('https://x.test/a%20b/"><script>.js');
  assert.equal(/[<>"\s?]/.test(rel), false, `unsafe chars survived: ${rel}`);
  assertInsideRoot(rel);
});

test('a URL can never escape the root', () => {
  for (const u of [
    'https://x.test/../../etc/passwd',
    'https://x.test/a/../../../etc/passwd',
    'https://x.test/..%2f..%2fetc/passwd',
  ]) {
    const { rel } = urlToTreePath(u);
    assertInsideRoot(rel);
    assert.equal(rel.split(sep).includes('..'), false, `dot-dot survived: ${rel}`);
  }
});

test('traversal is normalized away, not preserved', () => {
  const { rel } = urlToTreePath('https://x.test/a/b/../../c.js');
  assert.equal(rel, 'x.test/c.js');
});

test('the host leads the path so two origins never collide', () => {
  const a = urlToTreePath('https://a.test/logo.png');
  const b = urlToTreePath('https://b.test/logo.png');
  assert.notEqual(a.rel, b.rel);
  assert.ok(a.rel.startsWith('a.test'), a.rel);
});

test('the port distinguishes same-host different-origin', () => {
  const a = urlToTreePath('http://x.test:3000/logo.png');
  const b = urlToTreePath('http://x.test:4000/logo.png');
  assert.notEqual(a.rel, b.rel);
});

test('a directory URL gets an index.html', () => {
  const { rel, ext } = urlToTreePath('https://x.test/docs/');
  assert.equal(ext, '.html');
  assert.ok(rel.endsWith('index.html'), rel);
});

test('an extensionless document response is named by its content-type', () => {
  const { rel } = urlToTreePath('https://x.test/docs', { contentType: 'text/html' });
  assert.ok(rel.endsWith('index.html') || rel.endsWith('.html'), rel);
});

test('an unreserved tilde survives into the tree path', () => {
  // Next.js chunk names carry a literal `~`. Percent-encoding it to `%7E` stores
  // the file under a name the page never asks for, and Turbopack's chunk pairing
  // compares the authored filename byte-for-byte, so hydration never starts.
  const { rel } = urlToTreePath('https://x.test/_next/static/chunks/0aqjr575~a.js');
  assert.ok(rel.endsWith('/0aqjr575~a.js'), rel);
});

test('html is always .html, so the replica opens without a server guess', () => {
  assert.ok(urlToTreePath('https://x.test/', { contentType: 'text/html' }).rel.endsWith('index.html'));
});

test('a deeply nested path is preserved rather than flattened', () => {
  const { rel } = urlToTreePath('https://x.test/a/b/c/d/e.png');
  assert.ok(rel.endsWith(sep === '/' ? 'a/b/c/d/e.png' : 'a/b/c/d/e.png') || /a[/\\]b[/\\]c[/\\]d[/\\]e\.png$/.test(rel), rel);
});

test('a cross-origin asset lands under the capture host, not its own', () => {
  // Host-rooting the foreign asset is what wrote `../cdn.test/i.png` into a
  // document served from the capture's host directory: the reference resolved
  // above the served root, so the clone fell back to the live network.
  const { rel } = urlToTreePath('https://cdn.test/i.png', { origin: 'https://x.test/' });
  assert.equal(rel, 'x.test/__external__/cdn.test/i.png');
});

test('a cross-origin path never escapes the capture host directory', () => {
  for (const u of [
    'https://www.googletagmanager.com/gtag/js?id=G-1',
    'https://cdn.test:8443/deep/a/b/c.js',
    'https://a.b.c.test/',
  ]) {
    const { rel } = urlToTreePath(u, { origin: 'https://x.test/' });
    assert.equal(rel.split('/').includes('..'), false, `dot-dot survived: ${rel}`);
    assert.ok(rel.startsWith('x.test/'), rel);
    assertInsideRoot(rel);
  }
});

test('a cross-origin reference from the entry document needs no up-step', () => {
  const doc = urlToTreePath('https://x.test/', { contentType: 'text/html', isDocument: true });
  const asset = urlToTreePath('https://cdn.test/i.png', { origin: 'https://x.test/' });
  const ref = relativeFrom(doc.rel, asset.rel);
  assert.equal(ref, '__external__/cdn.test/i.png');
  assert.equal(ref.startsWith('..'), false, `escaping reference: ${ref}`);
});

test('a same-origin asset is unaffected by the capture origin', () => {
  const { rel } = urlToTreePath('https://x.test/a/b.js', { origin: 'https://x.test/' });
  assert.equal(rel, 'x.test/a/b.js');
});

test('a port makes an origin foreign to its own host', () => {
  const { rel } = urlToTreePath('http://x.test:3000/a.js', { origin: 'http://x.test/' });
  assert.equal(rel, 'x.test/__external__/x.test_3000/a.js');
});

test('assertSafeRel refuses anything that leaves the root', () => {
  assert.equal(assertSafeRel('x.test/a/b.js'), 'x.test/a/b.js');
  for (const bad of ['../a.js', 'x.test/../../a.js', '/x.test/a.js', '', 'a/../b.js']) {
    assert.throws(() => assertSafeRel(bad), /escapes capture root/, `accepted: ${bad}`);
  }
});

test('refInsideHostDir rejects only a reference that climbs past the host', () => {
  assert.equal(refInsideHostDir('x.test/index.html', '__external__/cdn.test/i.png'), true);
  assert.equal(refInsideHostDir('x.test/a/b/index.html', '../../__external__/cdn.test/i.png'), true);
  assert.equal(refInsideHostDir('x.test/index.html', '../cdn.test/i.png'), false);
  assert.equal(refInsideHostDir('x.test/a/index.html', '../../cdn.test/i.png'), false);
});