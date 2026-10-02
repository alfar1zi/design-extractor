import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { sweepPass, TABLET, MOBILE } from '../sweep-pass.mjs';
import { fetchChecked } from '../request-intercept.mjs';

// The sweep opens its own contexts, which the capture's interceptor does not
// cover. Chromium therefore follows redirects on its own unless something stops
// it, so "the target 302s to a link-local address" is the whole risk here. The
// internal server counts hits in memory: a log file written by a child process is
// not reliably visible in this sandbox.

let browser;
let dir;
const servers = [];

function serve(handler) {
  return new Promise((res) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => {
      servers.push(s);
      res(`http://127.0.0.1:${s.address().port}`);
    });
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'de-sweep-'));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close().catch(() => {});
  for (const s of servers) await new Promise((r) => s.close(r));
  await rm(dir, { recursive: true, force: true });
});

test('a hop that fails the safety check is never requested', async () => {
  // The invariant, at the level it is enforced. The sweep opens its own contexts,
  // which the capture's interceptor does not cover, so this guard is the only
  // thing between the page and wherever its 3xx points.
  //
  // Deliberately not modelled with two real servers: reaching a loopback server
  // at all needs `allowPrivate`, and that same flag is what permits the redirect
  // target. A live-server version would pass with the guard removed and fail with
  // it present, which proves nothing. The resolver stands in for DNS so hop 0
  // resolves public and only the link-local hop is refused.
  const requested = [];
  const redirect = () => ({
    status: () => 302,
    headers: () => ({ location: 'http://169.254.169.254/latest/meta-data/' }),
    dispose: async () => {},
  });
  const context = {
    request: { fetch: async (u) => { requested.push(u); return redirect(); } },
  };
  const route = { fetch: async () => redirect() };
  const resolver = async (host) => (host === 'ok.test' ? [{ address: '93.184.216.34', family: 4 }] : []);

  await assert.rejects(
    () => fetchChecked(context, route, 'https://ok.test/', { allowPrivate: false, resolver }),
    (e) => {
      assert.equal(e.blockedUrl, 'http://169.254.169.254/latest/meta-data/', 'the error names what was actually rejected');
      assert.equal(e.hops.length, 1, 'the 302 it was a redirect from is still reported');
      return true;
    },
  );
  assert.deepEqual(requested, [], 'the link-local hop was checked and never issued');
});

test('a refused sweep produces no screenshots rather than a broken pair', async () => {
  const origin = await serve((req, res) => { res.end('<h1>hi</h1>'); });
  const shots = await sweepPass(browser, origin, 15, dir);
  assert.deepEqual(shots, [], 'a private target is refused without allowPrivate');
});

test('the two viewports get their own contexts, so neither inherits the other\'s session', async () => {
  const origin = await serve((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<h1>hi</h1>'); });
  const shots = await sweepPass(browser, origin, 15, dir, { allowPrivate: true });
  assert.deepEqual(shots.map((s) => s.viewport), ['tablet', 'mobile']);
  assert.deepEqual(shots.map((s) => [s.width, s.height]), [[TABLET.width, TABLET.height], [MOBILE.width, MOBILE.height]]);
  for (const s of shots) assert.ok(existsSync(s.file), `${s.viewport}.png is on disk`);
});
