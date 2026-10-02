import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installStyleSampler } from './motion-sampler.mjs';
import { probeA11y, waitForSettle } from './dom-probe.mjs';
import { resolveTargets } from './target.mjs';
import { isBlockedResponse } from './request-intercept.mjs';
import { installCanvasRecorder } from './canvas-detect.mjs';

/** Report a selector that will not work, without aborting the ones that will. */
function warn(err, t) {
  if (t.error) err(`--target ${t.selector} is not a valid CSS selector: ${t.error}`);
  else err(`--target ${t.selector} matched nothing; the other targets still capture`);
}

/**
 * Navigate once, watch the load, and return the page plus everything read from it.
 *
 * This is the only pass that observes the page *during* load rather than after,
 * which is why the sampler is installed here and before `goto`: an intro that
 * runs on page load is over by the time any later pass runs, and no later pass
 * can recover it.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} url
 * @param {{width: number, height: number}} viewport
 * @param {number} timeoutSec
 * @param {string} outDir
 * @param {string[]} [scope] --target selectors. Fail the run when none of them
 *   matches: an output directory full of artifacts scoped to nothing is
 *   indistinguishable from a successful capture.
 * @param {(message: string) => void} err
 * @param {{quietFor: (ms: number) => boolean}} [store] the capture store, used to
 *   wait for responses to stop as well as for the DOM to stop growing.
 */
export async function recordPass(context, url, viewport, timeoutSec, outDir, scope = [], err = console.error, store) {
  const page = await context.newPage();
  // Before the first navigation: it records the canvas contexts the page itself
  // creates, which is the only way to tell a WebGL canvas from a 2d one without
  // asking the canvas and locking a context the page has not chosen yet.
  await installCanvasRecorder(page);
  await page.setViewportSize(viewport);
  const net = [];
  const con = [];
  page.on('request', (r) => net.push({ url: r.url(), method: r.method(), resourceType: r.resourceType(), ts: Date.now() }));
  page.on('response', async (r) => {
    const rec = net.find((n) => n.url === r.url() && !n.status);
    if (rec) {
      rec.status = r.status();
      rec.contentType = r.headers()['content-type'] || '';
      try { rec.size = Number(r.headers()['content-length'] || 0); } catch { rec.size = 0; }
    }
  });
  page.on('console', (m) => con.push({ level: m.type(), text: m.text(), location: m.location() || null, ts: Date.now() }));
  page.on('pageerror', (e) => con.push({ level: 'error', text: `pageerror: ${e.message}`, ts: Date.now() }));

  // Before the navigation, so it is already watching when the page's own scripts
  // run. `scope` goes in here rather than being filtered afterwards: a track that
  // is never created costs nothing, while filtering later still pays to observe
  // every element on the page.
  await installStyleSampler(page, { scope }).catch(() => {});

  const landed = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutSec * 1000 });
  // The interceptor fulfills a refused main-frame navigation with a 502 carrying
  // its own marker, which keeps `goto` from throwing. Left unchecked it sails
  // through to the screenshots below, and `viewport.png` ends up being a picture
  // of the error message filed as what the site looks like. There is nothing to
  // salvage here, so it fails the run instead of producing a plausible lie.
  if (isBlockedResponse(landed)) {
    throw new Error(`refused to capture ${landed.url()}: the navigation was blocked by the SSRF guard`);
  }
  // SPAs hold long-poll and websocket connections open, so networkidle never fires.
  // Wait for the DOM to stop growing instead of guessing with a fixed sleep.
  const settle = await waitForSettle(page, { network: store && ((ms) => store.quietFor(ms)) });

  if (scope.length) {
    const resolved = await resolveTargets(page, scope);
    if (!resolved.some((t) => t.matches > 0)) {
      const why = resolved.map((t) => `${t.selector} (${t.error || '0 matches'})`).join(', ');
      throw new Error(`No --target selector matched anything on this page: ${why}`);
    }
    // One bad selector must not lose the other two, so this warns instead of throwing.
    for (const t of resolved) if (t.matches === 0) warn(err, t);
  }

  const screenshotDir = join(outDir, 'screenshots');
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, 'viewport.png') });
  await page.screenshot({ path: join(screenshotDir, 'full.png'), fullPage: true });

  const a11y = await probeA11y(page) || { role: 'root', name: '', children: [] };
  const dom = await page.content();
  const docHeight = await page.evaluate(() => document.documentElement.scrollHeight);

  return { page, a11y, dom, docHeight, net, con, screenshotDir, settle };
}