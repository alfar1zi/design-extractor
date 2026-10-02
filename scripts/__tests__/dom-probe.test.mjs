// dom-probe.test.mjs - the timing contract of waitForSettle, and the shape of probeA11y.
//
// waitForSettle replaced a fixed 1500ms sleep. Asserting only that it "returns"
// would pass for a sleep, a hang and a settle alike, so every test here pins a
// measurable bound: when it is allowed to return, when it is not, and what it
// reports when it gave up.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { probeA11y, waitForSettle } from '../dom-probe.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser.close(); });

/** A fresh context per test: one browser, but no shared DOM between measurements. */
async function withPage(html, fn) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await fn(page);
  } finally {
    await context.close();
  }
}

/**
 * A waitForSettle with its cap check removed never returns, and `node --test`
 * has no default per-test deadline - so that mutation would hang the run
 * instead of turning it red. Racing a deadline is what makes "the cap is a real
 * ceiling" an assertion rather than a hope.
 */
function withDeadline(promise, ms = 10_000) {
  let reject;
  const guard = new Promise((_, r) => { reject = r; });
  const timer = setTimeout(
    () => reject(new Error(`waitForSettle had not returned after ${ms}ms: the cap is not a real ceiling`)),
    ms,
  );
  timer.unref();
  return Promise.race([promise, guard]);
}

test('a page that stops changing settles on its own, well inside the cap', async () => {
  const result = await withPage('<p>quiet</p>', (page) => withDeadline(
    waitForSettle(page, { stableMs: 200, capMs: 20_000, pollMs: 25 })));

  assert.equal(result.timedOut, false, 'it settled, so it must not claim a timeout');
  // Return is only permitted once the node count has been unchanged for
  // stableMs, so elapsedMs can never be shorter than stableMs.
  assert.ok(result.elapsedMs >= 200, `settled too early: ${result.elapsedMs}ms < stableMs 200ms`);
  assert.ok(result.elapsedMs < 20_000, `waited for the cap instead of the page: ${result.elapsedMs}ms`);
});

test('a page still appending nodes is not settled, however long the count held', async () => {
  // Appends 5 nodes at 100ms intervals, then stops. From poll 2 onward the node
  // count is changing repeatedly, so a "has not changed this poll" check alone
  // is not enough - only a reset of the stability window catches it.
  const growing = `<!doctype html><body><p>seed</p><script>
    window.__appended = 0;
    const id = setInterval(() => {
      document.body.appendChild(document.createElement('i'));
      window.__appended++;
      if (window.__appended === 5) clearInterval(id);
    }, 100);
  </script>`;

  const { result, appended } = await withPage(growing, async (page) => ({
    result: await withDeadline(waitForSettle(page, { stableMs: 200, capMs: 20_000, pollMs: 25 })),
    appended: await page.evaluate(() => window.__appended),
  }));

  assert.equal(appended, 5, 'the settle must not truncate a page that was still hydrating');
  assert.equal(result.timedOut, false);
  // The last append cannot land before 400ms, and the return then needs another
  // full stableMs after it. Anything near 200ms is a fixed sleep, not a settle.
  assert.ok(result.elapsedMs >= 550, `returned at ${result.elapsedMs}ms, before the DOM finished growing`);
});

test('a page that never stops mutating still returns, and reports the cap', async () => {
  const forever = `<!doctype html><body><p>spinner</p><script>
    window.__appended = 0;
    setInterval(() => {
      document.body.appendChild(document.createElement('i'));
      window.__appended++;
    }, 10);
  </script>`;

  const { result, appended } = await withPage(forever, async (page) => ({
    result: await withDeadline(waitForSettle(page, { stableMs: 200, capMs: 600, pollMs: 50 })),
    appended: await page.evaluate(() => window.__appended),
  }));

  assert.equal(result.timedOut, true, 'gave up on the cap, and says so instead of claiming a settle');
  assert.ok(result.elapsedMs >= 600, `returned at ${result.elapsedMs}ms, before the ${600}ms cap`);
  assert.ok(result.elapsedMs < 5_000, `the cap is a ceiling, not an open-ended wait: ${result.elapsedMs}ms`);
  // Proof the page really was still moving when it gave up, rather than a
  // settled page that had a cap configured.
  assert.ok(appended > 5, `page was still growing, only ${appended} appends happened`);
});

test('a page still loading is not settled even when its DOM has held still', async (t) => {
  // A parser-blocking script keeps readyState at 'loading'. The node count is
  // constant for the whole run, so only the readyState check can hold this open.
  const server = createServer((req, res) => {
    if (req.url.startsWith('/slow.js')) {
      setTimeout(() => res.writeHead(200, { 'content-type': 'text/javascript' }).end('/* late */'), 1500);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>loading</title><p>parsed</p><script src="/slow.js"></script>');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => server.close(ok)));

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'commit' });

    const result = await withDeadline(waitForSettle(page, { stableMs: 200, capMs: 600, pollMs: 50 }));

    assert.equal(result.timedOut, true, 'a document that never finished parsing is not settled');
    assert.ok(result.elapsedMs >= 600, `returned at ${result.elapsedMs}ms, before the ${600}ms cap`);
  } finally {
    await context.close();
  }
});

test('a network callback that never reports quiet holds the settle open by itself', async () => {
  let calls = 0;
  // A perfectly static, fully loaded page. Nothing but the callback can stop it
  // settling, which is the point: this is the "markup is done, chunks are not"
  // case the DOM check alone used to truncate.
  const result = await withPage('<p>static</p>', (page) => withDeadline(
    waitForSettle(page, {
      stableMs: 100, capMs: 500, pollMs: 50,
      network: () => { calls++; return false; },
    })));

  assert.equal(result.timedOut, true, 'a page that never goes quiet on the network is not settled');
  assert.ok(result.elapsedMs >= 500, `returned at ${result.elapsedMs}ms, before the ${500}ms cap`);
  assert.ok(calls > 3, `the callback is consulted every poll, not once: ${calls} call(s)`);
});

test('a network callback that reports quiet lets the same page settle', async () => {
  let calls = 0;
  const result = await withPage('<p>static</p>', (page) => withDeadline(
    waitForSettle(page, { stableMs: 200, capMs: 2_000, pollMs: 25, network: () => { calls++; return true; } })));

  assert.equal(result.timedOut, false, 'quiet network, static DOM: it settles');
  assert.ok(result.elapsedMs >= 200, `settled before the stable window elapsed: ${result.elapsedMs}ms`);
  assert.ok(calls > 3, `the callback is consulted every poll, not once: ${calls} call(s)`);
});

const LANDMARKS = `<!doctype html><body>
  <header><a href="/home">Home</a></header>
  <nav aria-label="Primary"><a href="/docs">Docs</a></nav>
  <main>
    <h1>Clone engine</h1>
    <button aria-label="Close dialog">&times;</button>
    <img src="/diagram.png" alt="A diagram">
  </main>
  <footer>&copy; 2026</footer>
</body>`;

/** Every node in the probe's tree, as `{role, name, tag}` triples. */
function flatten(node, acc = []) {
  if (!node) return acc;
  acc.push({ role: node.role, name: node.name, tag: node.tag });
  for (const child of node.children || []) flatten(child, acc);
  return acc;
}

test('a page with landmarks and controls yields a named tree', async () => {
  const tree = await withPage(LANDMARKS, (page) => probeA11y(page));
  const nodes = flatten(tree);

  assert.equal(tree.tag, 'html', 'the walk is rooted at the document element');
  assert.ok(nodes.some((n) => n.role === 'main'), `no main landmark: ${JSON.stringify(nodes)}`);
  // aria-label outranks the text content, and alt names an image.
  assert.ok(nodes.some((n) => n.role === 'button' && n.name === 'Close dialog'),
    `aria-label is not the accessible name: ${JSON.stringify(nodes)}`);
  assert.ok(nodes.some((n) => n.role === 'img' && n.name === 'A diagram'),
    `alt is not the accessible name: ${JSON.stringify(nodes)}`);
  // href alone is what promotes a bare <a> to a link.
  assert.ok(nodes.some((n) => n.role === 'link' && n.name === 'Home'));
  assert.ok(nodes.some((n) => n.role === 'link' && n.name === 'Docs'));
});

test('a heading or landmark is reported without any explicit role attribute', async () => {
  // The role lookup used to test tag names against a set that also held ARIA
  // role names, so `heading`, `navigation`, `banner` and `contentinfo` could
  // never match anything, and a bare <h1> with no children was dropped whole.
  // Every case below carries no role attributes at all, which is the normal
  // case: an author writes <h1>, not <h1 role="heading">.
  const rolesIn = async (html) => flatten(await withPage(html, (page) => probeA11y(page)));

  assert.deepEqual(
    (await rolesIn('<!doctype html><body><h1>Silent</h1></body>'))
      .filter((n) => n.role === 'heading'),
    [{ role: 'heading', name: 'Silent', tag: 'h1' }],
    'a bare <h1> is a heading, not a nameless div');

  assert.deepEqual(
    (await rolesIn('<!doctype html><body><h2>Sub</h2><h3>Deeper</h3></body>'))
      .filter((n) => n.role === 'heading').map((n) => n.name),
    ['Sub', 'Deeper'], 'the whole heading range, not just h1');

  // `html` and `body` have no role of their own and are kept only because they
  // have children, so they ride along as nulls. They are the walk's spine, not
  // landmarks.
  assert.deepEqual(
    (await rolesIn('<!doctype html><body><nav>Links</nav><header>Top</header><footer>Bottom</footer></body>'))
      .map((n) => n.role).filter(Boolean).sort(),
    ['banner', 'contentinfo', 'navigation'], 'landmarks are reported');
});

test('an input reports the role its type gives it', async () => {
  // `<input>` is one tag with a dozen roles, all chosen by `type`. Treating it
  // as either everything or nothing was the same bug one level down.
  const rolesIn = async (html) => flatten(await withPage(html, (page) => probeA11y(page)))
    .filter((n) => n.tag === 'input').map((n) => n.role);

  assert.deepEqual(
    await rolesIn('<!doctype html><body><input type="checkbox"><input type="radio">'
      + '<input type="range"><input type="search"><input type="submit"><input></body>'),
    ['checkbox', 'radio', 'slider', 'searchbox', 'button', 'textbox'],
    'each type maps to its own role, and a bare <input> is a textbox');
});

test('an explicit role attribute overrides the implicit one', async () => {
  // The probe reports what the author wrote. Silently correcting an invalid role
  // would hide a real defect in the page being captured.
  const nodes = flatten(await withPage(
    '<!doctype html><body><h1 role="presentation">Odd</h1>'
    + '<button role="menuitem">Item</button></body>', (page) => probeA11y(page)));

  assert.ok(nodes.some((n) => n.tag === 'h1' && n.role === 'presentation'),
    `the authored role was replaced: ${JSON.stringify(nodes)}`);
  assert.ok(nodes.some((n) => n.tag === 'button' && n.role === 'menuitem'));
});

test('a page with no roles at all returns null instead of throwing', async () => {
  const rolesIn = async (html) => flatten(await withPage(html, (page) => probeA11y(page)));

  assert.deepEqual(
    await rolesIn('<!doctype html><body><div><span>plain text</span></div></body>'),
    [], 'no roles means nothing to report, not a phantom root node');

  // The contrast is the assertion. Both pages have the same markup apart from
  // one button; if the first also came back empty for a reason other than the
  // missing roles, this test would still pass.
  assert.deepEqual(
    (await rolesIn('<!doctype html><body><div><span>plain text</span><button>Go</button></div></body>'))
      .filter((n) => n.role === 'button'),
    [{ role: 'button', name: 'Go', tag: 'button' }]);
});

test('the depth limit is real, and is the only thing dropping the deep button', async () => {
  // Two identical buttons, differing only in nesting. A shallow one proving the
  // walk works is what makes the missing deep one mean "too deep" and not
  // "nothing was found at all".
  const deep = `${'<div>'.repeat(12)}<button>Deep</button>${'</div>'.repeat(12)}`;
  const html = `<!doctype html><body><main><button>Shallow</button></main>${deep}`;
  const names = flatten(await withPage(html, (page) => probeA11y(page)))
    .filter((n) => n.role === 'button').map((n) => n.name);

  assert.ok(names.includes('Shallow'), `the shallow button is missing: ${JSON.stringify(names)}`);
  assert.ok(!names.includes('Deep'), `a node 13 levels down beat the depth limit: ${JSON.stringify(names)}`);
});

test('waitForSettle reports how many polls it actually ran', async () => {
  // `polls` is documented on the return type and was hard-coded to 0, so a
  // consumer reading it saw a settle that never looked at the page. It is the
  // only signal distinguishing "settled on the first look" from "settled after
  // thirty", which is the difference between a fast page and a slow one.
  const fast = await withPage('<p>static</p>', (page) => withDeadline(
    waitForSettle(page, { stableMs: 100, capMs: 5_000, pollMs: 25 })));
  assert.ok(fast.polls >= 4, `expected several polls, got ${fast.polls}`);

  const slow = await withPage('<p>static</p>', (page) => withDeadline(
    waitForSettle(page, { stableMs: 400, capMs: 5_000, pollMs: 25 })));
  assert.ok(slow.polls > fast.polls,
    `a longer stable window must take more polls: ${slow.polls} vs ${fast.polls}`);
});
