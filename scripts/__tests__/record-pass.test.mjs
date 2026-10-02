import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { recordPass } from '../record-pass.mjs';
import { BLOCKED_HEADER } from '../request-intercept.mjs';

const FIXTURE = fileURLToPath(new URL('fixtures/shadcn-gsap', import.meta.url));
const VIEWPORT = { width: 1280, height: 900 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function withPage(fn, handler) {
  const { readFile } = await import('node:fs/promises');
  const { extname } = await import('node:path');
  const server = createServer(handler ?? (async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    try {
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' })
        .end(await readFile(join(FIXTURE, rel)));
    } catch {
      res.writeHead(404).end('not found');
    }
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'de-record-'));
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    await fn(context, `http://127.0.0.1:${server.address().port}/`, dir);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

test('a navigation the SSRF guard refused fails the run instead of screenshotting the refusal', async () => {
  // The refusal is fulfilled rather than aborted, on purpose: aborting makes
  // `goto` throw ERR_BLOCKED_BY_CLIENT and leaves nothing to inspect. Left
  // unchecked, a fulfilled 502 sails straight through to the screenshots, and
  // `full.png` becomes a photograph of our own error text filed as the site.
  // A plausible-looking lie is worse than a failure.
  await withPage(async (context, url, dir) => {
    await assert.rejects(
      recordPass(context, url, VIEWPORT, 20, dir, [], () => {}),
      (e) => {
        assert.match(e.message, /blocked by the SSRF guard/);
        assert.match(e.message, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
    );
  }, (req, res) => {
    // Exactly what `refusal()` fulfils with.
    res.writeHead(502, { [BLOCKED_HEADER]: '1', 'content-type': 'text/plain; charset=utf-8' });
    res.end('design-extractor blocked this request.\n\nURL: 169.254.169.254\nReason: link-local\n');
  });

  // Nothing may have been written: a failed run that still leaves a
  // `full.png` is a failed run a consumer cannot tell from a successful one.
  const dir = await mkdtemp(join(tmpdir(), 'de-record-leak-'));
  try {
    await withPage(async (context, url) => {
      await assert.rejects(recordPass(context, url, VIEWPORT, 20, dir, [], () => {}), /SSRF guard/);
      await assert.rejects(stat(join(dir, 'screenshots', 'full.png')), { code: 'ENOENT' },
        'a refused capture leaves no screenshot behind');
    }, (req, res) => {
      res.writeHead(502, { [BLOCKED_HEADER]: '1', 'content-type': 'text/plain' });
      res.end('blocked');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a plain 502 from the site is not mistaken for a refusal', async () => {
  // The header is what separates the two. Without this, the guard would also
  // reject every site that legitimately returns 502, and the error would name
  // an SSRF block that never happened.
  await withPage(async (context, url, dir) => {
    const r = await recordPass(context, url, VIEWPORT, 20, dir, [], () => {});
    assert.ok(r.page, 'a real 502 from the site is captured, not refused');
    assert.ok((await stat(join(dir, 'screenshots', 'full.png'))).size > 0,
      'and its screenshot is written, because the capture succeeded');
  }, (req, res) => {
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>upstream is down</h1></body></html>');
  });
});

test('a --target that matches nothing fails the run rather than capturing nothing', async () => {
  await withPage(async (context, url, dir) => {
    await assert.rejects(
      recordPass(context, url, VIEWPORT, 20, dir, ['#no-such-thing'], () => {}),
      /No --target selector matched anything[\s\S]*#no-such-thing/,
    );
  });
});

test('one --target that matches nothing warns and the others still capture', async () => {
  await withPage(async (context, url, dir) => {
    const warnings = [];
    const r = await recordPass(context, url, VIEWPORT, 20, dir,
      ['.card', '#nope'], (m) => warnings.push(m));
    assert.ok(r.page, 'the matching target kept the run alive');
    assert.equal(warnings.length, 1, 'and the dead one is reported');
    assert.match(warnings[0], /#nope matched nothing/);
  });
});
