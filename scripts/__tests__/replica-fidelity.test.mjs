import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { scoreFidelity } from '../fidelity.mjs';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('fixtures/shadcn-gsap', import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const PAUSE = '*{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';

/**
 * Static file server over a directory. `tweak` rewrites a served file and
 * exists only for the negative control below.
 */
async function serveDir(dir, tweak) {
  const server = createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    try {
      let body = await readFile(join(dir, rel));
      if (tweak && rel.endsWith('.css')) body = Buffer.from(tweak(String(body)));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { close: () => new Promise((r) => server.close(r)), url: `http://127.0.0.1:${server.address().port}/` };
}

/** One Chromium, one viewport, one deviceScaleFactor, for every side. */
async function shoot(browser, target, dest) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(PAUSE);
  // A replica that still reaches the network is not a replica: the pixels
  // would match for the wrong reason and the capture would be hollow.
  const external = [];
  await page.route('**/*', (route) => {
    if (!route.request().url().startsWith('http://127.0.0.1:')) external.push(route.request().url());
    return route.continue();
  });
  await page.goto(target, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__fixtureMotionSettled === true, null, { timeout: 20000 });
  await page.screenshot({ path: dest, fullPage: true, animations: 'disabled' });
  await ctx.close();
  return external;
}

test('the offline replica renders the same pixels as the site it was captured from', async () => {
  // The claim the whole tool is sold on, and the only assertion in the suite
  // that is not one module agreeing with another. Everything else proves
  // internal consistency; this proves the product.
  const original = await serveDir(FIXTURE);
  const out = await mkdtemp(join(tmpdir(), 'de-fidelity-'));
  const shotsA = await mkdtemp(join(tmpdir(), 'de-orig-'));
  const shotsB = await mkdtemp(join(tmpdir(), 'de-repl-'));
  const shotsC = await mkdtemp(join(tmpdir(), 'de-tamp-'));
  const open = [];
  let browser = null;
  try {
    await exec(process.execPath, [CLI, original.url, '--out', out, '--quick', '--skip-save',
      '--allow-private', '--no-sweep', '--no-states', '--no-interactions', '--timeout', '30'],
    { timeout: 180000 });

    const hosts = await readdir(join(out, 'live', 'tree'));
    const replica = await serveDir(join(out, 'live', 'tree', hosts[0]));
    // One token changed. If the diff cannot see this, the diff is not reading
    // pixels and every number below it is meaningless.
    const tampered = await serveDir(join(out, 'live', 'tree', hosts[0]),
      (css) => css.replace('--radius: 0.5rem', '--radius: 24px'));
    open.push(replica, tampered);

    browser = await chromium.launch();
    assert.deepEqual(await shoot(browser, original.url, join(shotsA, 'full.png')), [],
      'the original fixture has no external references');
    assert.deepEqual(await shoot(browser, replica.url, join(shotsB, 'full.png')), [],
      'the replica renders without leaving 127.0.0.1');
    await shoot(browser, tampered.url, join(shotsC, 'full.png'));

    const faithful = await scoreFidelity(shotsA, shotsB, { viewports: ['full'] });
    const control = await scoreFidelity(shotsA, shotsC, { viewports: ['full'] });
    const row = faithful.viewports[0];
    console.log('FIDELITY', JSON.stringify({
      faithful: row.diffRatio, faithfulStatus: faithful.status,
      control: control.viewports[0].diffRatio, controlClusters: control.viewports[0].clusters,
    }));

    assert.equal(faithful.measured, 1, 'the two renders were actually compared');
    assert.equal(row.diffRatio, 0,
      `the captured tree replays the original pixel for pixel; got ${row.diffRatio}`);

    // The negative control. Without it, a harness that compared two blank
    // pages would also report 0 and this test would be worth nothing.
    assert.ok(control.viewports[0].diffRatio > 0,
      'the comparison detects a single changed token, so a 0 above is a measurement');
    assert.ok(control.viewports[0].clusters > 0,
      'and it localises the change, because a bare scalar hides where it went wrong');
  } finally {
    if (browser) await browser.close();
    for (const s of open) await s.close();
    await original.close();
    for (const d of [out, shotsA, shotsB, shotsC]) await rm(d, { recursive: true, force: true });
  }
});
