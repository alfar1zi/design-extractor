import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rewriteHtml, rewriteCss, rewriteJs, resolveAgainst } from '../rewrite.mjs';
import { createCaptureStore } from '../capture-store.mjs';
import { writeTree } from '../tree-writer.mjs';

const map = (pairs) => {
  const byUrl = new Map(Object.entries(pairs));
  return (url) => byUrl.get(url) || null;
};

test('resolveAgainst makes a relative URL absolute against the document URL', () => {
  assert.equal(resolveAgainst('https://x.test/a/b.html', './c.png'), 'https://x.test/a/c.png');
  assert.equal(resolveAgainst('https://x.test/a/b.html', '/c.png'), 'https://x.test/c.png');
  assert.equal(resolveAgainst('https://x.test/a/b.html', 'd.png'), 'https://x.test/a/d.png');
  assert.equal(resolveAgainst('https://x.test/a/b.html', '//cdn.test/e.png'), 'https://cdn.test/e.png');
  assert.equal(resolveAgainst('https://x.test/a/b.html', 'https://z.test/f.png'), 'https://z.test/f.png');
});

test('resolveAgainst leaves inert references alone', () => {
  assert.equal(resolveAgainst('https://x.test/a', '#top'), null);
  assert.equal(resolveAgainst('https://x.test/a', 'data:image/png;base64,AAA'), null);
  assert.equal(resolveAgainst('https://x.test/a', 'javascript:void(0)'), null);
  assert.equal(resolveAgainst('https://x.test/a', 'mailto:a@b.test'), null);
});

test('a script src on another origin is rewritten to its tree path', () => {
  const out = rewriteHtml('<script src="https://x.test/js/a.js"></script>', { baseUrl: 'https://page.test/', resolver: map({ 'https://x.test/js/a.js': '../x.test/js/a.js' }) });
  assert.match(out, /src="\.\.\/x\.test\/js\/a\.js"/);
});

test('a link href is rewritten', () => {
  const out = rewriteHtml('<link rel="stylesheet" href="https://x.test/a.css">', { baseUrl: 'https://page.test/', resolver: map({ 'https://x.test/a.css': '../x.test/a.css' }) });
  assert.match(out, /href="\.\.\/x\.test\/a\.css"/);
});

test('img src is rewritten', () => {
  const out = rewriteHtml('<img src="https://x.test/i.png">', { baseUrl: 'https://page.test/', resolver: map({ 'https://x.test/i.png': '../x.test/i.png' }) });
  assert.match(out, /src="\.\.\/x\.test\/i\.png"/);
});

test('a srcset keeps its descriptors and rewrites every candidate', () => {
  const out = rewriteHtml('<img srcset="https://x.test/i.png 1x, https://x.test/i.png 2x">', { baseUrl: 'https://page.test/', resolver: map({ 'https://x.test/i.png': '../x.test/i.png' }) });
  assert.equal(out, '<base href="./"><img srcset="../x.test/i.png 1x, ../x.test/i.png 2x">');
});

test('a source srcset inside picture is rewritten', () => {
  const out = rewriteHtml('<picture><source srcset="https://x.test/i.webp"><img src="https://x.test/i.png"></picture>', {
    baseUrl: 'https://page.test/',
    resolver: map({ 'https://x.test/i.webp': '../x.test/i.webp', 'https://x.test/i.png': '../x.test/i.png' }),
  });
  assert.match(out, /srcset="\.\.\/x\.test\/i\.webp"/);
  assert.match(out, /src="\.\.\/x\.test\/i\.png"/);
});

test('an unresolvable URL is left untouched and counted, never dropped', () => {
  const missed = [];
  const out = rewriteHtml('<img src="https://x.test/missing.png">', { baseUrl: 'https://page.test/', resolver: map({}), collect: (m) => missed.push(...m) });
  assert.match(out, /<img src="https:\/\/x\.test\/missing\.png">/, 'the reference must survive verbatim');
  assert.deepEqual(missed.map((s) => s.url), ['https://x.test/missing.png']);
});

test('a base href is injected so relative paths resolve on the filesystem', () => {
  const out = rewriteHtml('<html><head><title>t</title></head></html>', { baseUrl: 'https://x.test/', resolver: map({}) });
  assert.match(out, /<base href="\.\/">/);
});

test('an existing base href is replaced, not duplicated', () => {
  const out = rewriteHtml('<html><head><base href="https://evil.test/"></head></html>', { baseUrl: 'https://x.test/', resolver: map({}) });
  assert.equal((out.match(/<base /g) || []).length, 1);
  assert.match(out, /<base href="\.\/">/);
});

test('a same-origin reference survives byte-for-byte so a bundle runtime can pair its chunk', () => {
  const missed = [];
  const out = rewriteHtml('<script src="/_next/static/chunks/0aqjr575~a.js" async></script>', {
    baseUrl: 'https://x.test/',
    resolver: map({ 'https://x.test/_next/static/chunks/0aqjr575~a.js': '_next/static/chunks/0aqjr575%7Ea.js' }),
    collect: (m) => missed.push(...m),
  });
  assert.match(out, /src="\/_next\/static\/chunks\/0aqjr575~a\.js"/, 'the literal attribute is program input, not just a locator');
  assert.deepEqual(missed, [], 'a same-origin reference is left in place, not reported as a miss');
});

test('a same-origin srcset is left alone too', () => {
  const out = rewriteHtml('<img srcset="/i.png 1x, /i.png 2x">', { baseUrl: 'https://x.test/', resolver: map({}) });
  assert.equal(out, '<base href="./"><img srcset="/i.png 1x, /i.png 2x">');
});

test('a relative same-origin reference keeps its own wording', () => {
  const out = rewriteHtml('<img src="sub/i.png">', { baseUrl: 'https://x.test/docs/', resolver: map({}) });
  assert.match(out, /src="sub\/i\.png"/);
});

test('inline style blocks are rewritten too', () => {
  const out = rewriteHtml('<style>body{background:url(/bg.png)}</style>', {
    baseUrl: 'https://x.test/', resolver: map({ 'https://x.test/bg.png': '../x.test/bg.png' }),
  });
  assert.match(out, /url\("\.\.\/x\.test\/bg\.png"\)/);
});

test('url() in a stylesheet is rewritten, including quoted forms', () => {
  const resolver = map({ 'https://x.test/f.woff2': '../x.test/f.woff2' });
  assert.match(rewriteCss('@font-face{src:url(/f.woff2)}', { baseUrl: 'https://x.test/a.css', resolver }).text, /url\("\.\.\/x\.test\/f\.woff2"\)/);
});

test('@import is rewritten in both url() and bare-string form', () => {
  const resolver = map({ 'https://x.test/a.css': '../x.test/a.css', 'https://x.test/b.css': '../x.test/b.css' });
  assert.match(rewriteCss('@import url("/a.css");', { baseUrl: 'https://x.test/', resolver }).text, /@import url\("\.\.\/x\.test\/a\.css"\)/);
  assert.match(rewriteCss('@import "/b.css";', { baseUrl: 'https://x.test/', resolver }).text, /@import "\.\.\/x\.test\/b\.css"/);
});

test('a data: url in CSS is not touched', () => {
  const css = 'body{background:url(data:image/svg+xml;base64,AAA)}';
  assert.equal(rewriteCss(css, { baseUrl: 'https://x.test/', resolver: map({}) }).text, css);
});

test('a string literal in a fetch call is rewritten', () => {
  const out = rewriteJs('fetch("/api/users").then(r=>r.json())', { baseUrl: 'https://x.test/a.js', resolver: map({ 'https://x.test/api/users': '../x.test/api/users' }) });
  assert.match(out.text, /fetch\("\.\.\/x\.test\/api\/users"\)/);
});

test('a dynamic import specifier is rewritten', () => {
  const out = rewriteJs('const m = await import("/chunk.js");', { baseUrl: 'https://x.test/a.js', resolver: map({ 'https://x.test/chunk.js': '../x.test/chunk.js' }) });
  assert.match(out.text, /import\("\.\.\/x\.test\/chunk\.js"\)/);
});

test('a non-matching string literal is left alone', () => {
  const js = 'const name = "hello"; log("world");';
  assert.equal(rewriteJs(js, { baseUrl: 'https://x.test/a.js', resolver: map({}) }).text, js);
});

test('rewriting HTML does not corrupt text content that looks like markup', () => {
  const html = '<p>use &lt;script src="/a.js"&gt; carefully</p>';
  assert.match(rewriteHtml(html, { baseUrl: 'https://x.test/', resolver: map({ 'https://x.test/a.js': '../x.test/a.js' }) }), /&lt;script src="\/a\.js"&gt;/);
});

test('a string inside a script body survives verbatim', () => {
  const html = '<script>var s = "<img src=\'/i.png\'>";</script>';
  const out = rewriteHtml(html, { baseUrl: 'https://x.test/', resolver: map({ 'https://x.test/i.png': '../x.test/i.png' }) });
  assert.match(out, /<img src='\/i\.png'>/, 'markup inside a JS string must not be treated as an attribute');
});

test('a JSON script block is not rewritten as JS', () => {
  const html = '<script type="application/json">{"url":"/a.js"}</script>';
  const out = rewriteHtml(html, { baseUrl: 'https://x.test/', resolver: map({ 'https://x.test/a.js': '../x.test/a.js' }) });
  assert.match(out, /\{"url":"\/a\.js"\}/);
});

test('the collect callback names every URL that could not be resolved', () => {
  const missed = [];
  rewriteHtml('<img src="https://x.test/miss1.png"><link href="https://x.test/miss2.css">', { baseUrl: 'https://page.test/', resolver: map({}), collect: (m) => missed.push(...m) });
  assert.deepEqual(missed.map((s) => s.url).sort(), ['https://x.test/miss1.png', 'https://x.test/miss2.css']);
});

test('rewriteCss is idempotent: a second pass changes nothing', () => {
  const resolver = map({ 'https://x.test/f.woff2': '../x.test/f.woff2' });
  const once = rewriteCss('@font-face{src:url(/f.woff2)}', { baseUrl: 'https://x.test/a.css', resolver }).text;
  assert.equal(rewriteCss(once, { baseUrl: 'https://x.test/a.css', resolver: map({}) }).text, once);
});

// The real pair: a store holding a real page, written to a real tree. A resolver
// that returns `../cdn.test/i.png` is not a hypothetical — it is what the tree
// layout used to produce, and it only shows up once the bytes hit the disk.
function pair(url, opts = {}) {
  const { method = 'GET', resourceType = 'script', isNavigationRequest = false, contentType = 'application/javascript' } = opts;
  return {
    request: { url: () => url, method: () => method, resourceType: () => resourceType, isNavigationRequest: () => isNavigationRequest },
    response: { url: () => url, status: () => 200, headers: () => ({ 'content-type': contentType }) },
  };
}

test('a cross-origin reference resolves to a file inside the written tree', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'de-rewrite-'));
  const store = createCaptureStore();
  const put = (url, body, opts) => {
    const { request, response } = pair(url, opts);
    store.put(request, response, Buffer.from(body));
  };
  put('https://x.test/', '<link rel="stylesheet" href="https://cdn.test/a.css">', { resourceType: 'document', isNavigationRequest: true, contentType: 'text/html' });
  put('https://cdn.test/a.css', 'body{}', { contentType: 'text/css' });

  await writeTree(store, { outDir });
  const docRel = store.get('https://x.test/').rel;
  const html = await readFile(join(outDir, docRel), 'utf8');
  const ref = html.match(/<link\b[^>]*\bhref="([^"]+)"/)[1];

  assert.equal(ref.split('/').includes('..'), false, `reference climbs out of the tree: ${ref}`);
  // Resolves the way a browser would: against the document's own directory.
  const target = resolve(outDir, dirname(docRel), ref);
  assert.ok(target.startsWith(resolve(outDir) + '/'), `${target} is outside the tree`);
  assert.equal(await readFile(target, 'utf8'), 'body{}');
});