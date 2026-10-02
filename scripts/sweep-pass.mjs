// sweep-pass.mjs - capture the page at tablet and mobile widths.
//
// Extracted from inspect.mjs only to keep that file inside the AGENTS.md
// 400-line cap. Each viewport gets its own context: reusing one would carry the
// desktop session's cookies, cache and localStorage into the narrower renders
// and quietly change what is on screen.

import { join } from 'node:path';

import { fetchChecked, refusal, isBlockedResponse } from './request-intercept.mjs';

export const TABLET = { width: 768, height: 1024 };
export const MOBILE = { width: 375, height: 812 };

/**
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {number} timeoutSec
 * @param {string} screenshotDir
 * @param {{allowPrivate?: boolean}} [opts]
 */
export async function sweepPass(browser, url, timeoutSec, screenshotDir, { allowPrivate = false } = {}) {
  const out = [];
  for (const [label, vp] of [['tablet', TABLET], ['mobile', MOBILE]]) {
    const ctx = await browser.newContext({ viewport: vp });
    // These contexts are not the primary one, so the interceptor installed there
    // does not cover them. Without this route Chromium resolves DNS and follows
    // redirects itself, and a target that 302s to a link-local address reaches it
    // unchecked. Sweep is on by default, so this guard sits on the default path.
    await ctx.route('**/*', async (route, request) => {
      try {
        const { response } = await fetchChecked(ctx, route, request.url(), { allowPrivate, method: request.method() });
        return route.fulfill({ response });
      } catch (e) {
        // Fulfilled, not aborted, for the same reason the primary interceptor
        // does it: `route.abort` on a main-frame navigation makes `page.goto` throw
        // `ERR_BLOCKED_BY_CLIENT`, so refusing the target would take the whole pass
        // down and surface as a partial failure. Refusing is the correct outcome
        // here and must not read as a broken one.
        return route.fulfill(refusal(request.url(), e.message));
      }
    });
    const page = await ctx.newPage();
    try {
      const landed = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutSec * 1000 });
      // A fulfilled refusal is a 502 page, not the site. Screenshotting it would
      // hand the caller an image of our own error text filed as the tablet render,
      // so a refused viewport contributes nothing rather than something wrong.
      if (isBlockedResponse(landed)) continue;
      // SPA hydration wait (replaces networkidle which never fires on long-poll pages).
      await page.waitForTimeout(1500);
      const p = join(screenshotDir, `${label}.png`);
      await page.screenshot({ path: p, fullPage: true });
      out.push({ viewport: label, ...vp, file: p });
    } finally {
      await ctx.close();
    }
  }
  return out;
}