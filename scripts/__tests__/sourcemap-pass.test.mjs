import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sourcemapPass } from '../sourcemap-pass.mjs';

const MAP = { version: 3, sources: ['src/app.js'], sourcesContent: ['console.log(1);'] };
const plainJs = 'const a = 1; console.log(a);\n';

/** A JS file whose last line names its sourcemap. */
const jsWithMap = (mapUrl) => `console.log("hi");\n//# sourceMappingURL=${mapUrl}\n`;

/**
 * Two servers on 127.0.0.1: `target` serves the site's JS, `other` serves the
 * sourcemap. They are different origins, so `other` plays the part of a map
 * served by a host outside the capture.
 */
async function withServers(fn) {
  const hits = [];
  const listen = (handler) => new Promise((r) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => r(s));
  });

  const other = await listen((req, res) => {
    hits.push(`other:${req.url}`);
    if (req.url === '/tracker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(plainJs);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(MAP));
    }
  });
  const otherOrigin = `http://127.0.0.1:${other.address().port}`;

  const target = await listen((req, res) => {
    hits.push(req.url);
    if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(jsWithMap(`${otherOrigin}/app.js.map`));
    } else if (req.url === '/plain.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(plainJs);
    } else {
      res.writeHead(404).end('x');
    }
  });
  const dir = await mkdtemp(join(tmpdir(), 'de-smap-'));
  try {
    await fn({
      dir,
      hits,
      origin: `http://127.0.0.1:${target.address().port}`,
      otherOrigin,
    });
  } finally {
    for (const s of [target, other]) await new Promise((r) => s.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

test('a network entry from another origin is never fetched', async () => {
  // `net` is a record of everything the browser asked for, including
  // third-party scripts and redirect targets. Only this origin's own JS belongs
  // in the pass; fetching the rest turns a capture into a scanner.
  await withServers(async ({ dir, origin, otherOrigin, hits }) => {
    const before = hits.length;
    await sourcemapPass([
      { url: `${origin}/app.js` },
      { url: `${otherOrigin}/tracker.js` },
      { url: 'http://169.254.169.254/latest/meta-data.js' },
      { url: `${origin}/image.png` },
    ], { url: `${origin}/` }, dir);

    const fetched = hits.slice(before);
    assert.ok(fetched.includes('/app.js'), `the same-origin script was fetched: ${JSON.stringify(fetched)}`);
    assert.deepEqual(fetched.filter((u) => u.startsWith('other:')), [],
      'a reachable off-origin script was not requested');
    assert.ok(fetched.every((u) => u.startsWith('/')),
      `every request went to the target origin: ${JSON.stringify(fetched)}`);
  });
});

test('a sourceMappingURL on another origin is refused without --allow-private', async () => {
  // The comment is written by whoever served the JS, so it is target-controlled
  // input. Without the guard it is a blind fetch from this machine, and the
  // response body is parsed and written into the output directory.
  await withServers(async ({ dir, origin, hits }) => {
    const before = hits.length;
    const blocked = await sourcemapPass([{ url: `${origin}/app.js` }], { url: `${origin}/` }, dir);

    assert.deepEqual(blocked.jsSourcemap, [],
      'no source is claimed as recovered from a map that was never read');
    assert.equal(blocked.jsInferred.length, 1,
      'and the run still produces the AST fallback rather than nothing');
    assert.deepEqual(hits.slice(before).filter((u) => u.startsWith('other:')), [],
      'the off-origin map was not requested');
  });
});

test('a sourceMappingURL is read when --allow-private is set', async () => {
  // The flag is the difference between "refused" and "read". If threading broke,
  // the refusal above would still pass and this would silently stop working.
  await withServers(async ({ dir, origin, hits }) => {
    const before = hits.length;
    const allowed = await sourcemapPass([{ url: `${origin}/app.js` }],
      { url: `${origin}/`, allowPrivate: true }, dir);

    assert.equal(allowed.jsSourcemap.length, 1,
      'with the flag the map is read and the file is reported as js-sourcemap');
    assert.equal(allowed.jsInferred.length, 0,
      'and the fallback does not also claim the same file');
    assert.ok(hits.slice(before).includes('other:/app.js.map'),
      `the map was actually requested: ${JSON.stringify(hits.slice(before))}`);
  });
});

test('a script with no sourcemap is reported as inferred, never as sourcemap', async () => {
  // The buckets mean different things to a consumer: `js-sourcemap` is really
  // recovered source, `js-inferred` is an AST reading of the minified file. A
  // file with no map must never land in the first bucket.
  await withServers(async ({ dir, origin }) => {
    const r = await sourcemapPass([{ url: `${origin}/plain.js` }], { url: `${origin}/` }, dir);
    assert.deepEqual(r.jsSourcemap, []);
    assert.equal(r.jsInferred.length, 1);
  });
});

test('one unreachable script does not lose the others', async () => {
  await withServers(async ({ dir, origin }) => {
    const r = await sourcemapPass([
      { url: `${origin}/404-missing.js` },
      { url: `${origin}/plain.js` },
    ], { url: `${origin}/` }, dir);
    assert.equal(r.jsInferred.length, 1, 'the script that did load is still reported');
  });
});

test('a script that never answers does not hang the pass', { timeout: 60_000 }, async () => {
  // The fetch is bounded at 15s. Unbounded, one dead request holds the whole
  // capture open, and the artifacts already on disk never get finished.
  const server = createServer(() => { /* never responds */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = await mkdtemp(join(tmpdir(), 'de-smap-hang-'));
  try {
    const started = Date.now();
    const r = await sourcemapPass([{ url: `${origin}/stuck.js` }], { url: `${origin}/` }, dir);
    const elapsed = Date.now() - started;
    assert.deepEqual(r.jsSourcemap, []);
    assert.deepEqual(r.jsInferred, []);
    assert.ok(elapsed < 30_000, `the pass gave up on the dead request, took ${elapsed}ms`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
