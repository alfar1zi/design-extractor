import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const FIXTURE = fileURLToPath(new URL('fixtures/shadcn-gsap', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * The fixture's `#closed-host` attaches a shadow root with `mode: 'closed'`,
 * holding a <style> and a <p>.
 */
async function withClosedRootPage(fn) {
  const server = createServer(async (req, res) => {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    try {
      const body = await readFile(join(FIXTURE, rel));
      res.writeHead(200, { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__fixtureMotionSettled === true, null, { timeout: 20000 });
    await fn(page);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

/** Text nodes under every shadow root reachable from `node`. */
function shadowRootsWithText(node, acc = []) {
  for (const sr of node?.shadowRoots || []) {
    acc.push({ type: sr.shadowRootType, texts: textNodes({ children: sr.children }) });
    for (const c of sr.children || []) shadowRootsWithText(c, acc);
  }
  for (const c of node?.children || []) shadowRootsWithText(c, acc);
  return acc;
}

function textNodes(node, acc = []) {
  if (node?.nodeName === '#text' && node.nodeValue?.trim()) acc.push(node.nodeValue.trim());
  for (const c of node?.children || []) textNodes(c, acc);
  return acc;
}

test("CDP's pierce option crosses a closed shadow root that page JavaScript cannot see", async () => {
  // The build plan asserted `DOM.getDocument({pierce:true})` crosses closed
  // roots, and said so without ever running it. It does - measured here, in
  // Chromium, so the plan's contingency (label those subtrees opaque) is not
  // silently unmet.
  //
  // The point of the test is the CONTRAST: page JS cannot see the root at all,
  // and CDP can. Without that contrast, "we read the text" would also be true
  // of a plain open root and would prove nothing about closed ones.
  await withClosedRootPage(async (page) => {
    const cdp = await page.context().newCDPSession(page);
    await Promise.all([cdp.send('DOM.enable'), cdp.send('CSS.enable')]);

    const viaJs = await page.evaluate(() => {
      const host = document.getElementById('closed-host');
      return { hasShadowRoot: Boolean(host?.shadowRoot), text: host?.textContent ?? '' };
    });
    assert.equal(viaJs.hasShadowRoot, false, 'page JavaScript cannot see the root');
    assert.equal(viaJs.text, '', 'nor any of its text');

    const pierced = shadowRootsWithText(
      (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })).root);
    const closed = pierced.find((r) => r.type === 'closed');
    assert.ok(closed, `a closed shadow root is listed: ${JSON.stringify(pierced.map((r) => r.type))}`);
    assert.ok(closed.texts.some((t) => t.includes('inside a closed shadow root')),
      `its content is readable, not just its existence: ${JSON.stringify(closed.texts)}`);

    // pierce is what does it. Turn it off and the same root is an empty shell.
    const unpierced = shadowRootsWithText(
      (await cdp.send('DOM.getDocument', { depth: -1, pierce: false })).root);
    const sameClosed = unpierced.find((r) => r.type === 'closed');
    assert.ok(sameClosed, 'the root is still listed without pierce');
    assert.deepEqual(sameClosed.texts, [], 'but pierce is what carries its contents');
  });
});
