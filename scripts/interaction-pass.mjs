// interaction-pass.mjs - element-level interaction capture using Playwright Locator API.
// Extracted from inspect.mjs so the orchestrator stays under the AGENTS.md 400-line cap.
import { join } from 'node:path';

export const INTERACTION_CAP = 20;
export const INTERACTION_SEL = 'a[href], button:not([disabled]), [role="button"]:not([disabled]), input[type="submit"], [tabindex="0"]';
const CLICK_TIMEOUT_MS = 8000;
const HOVER_FALLBACK_MS = 800;

// Map Playwright error messages to a short result category for interactions.json / hover.json.
// Returns one of: 'ok', 'timeout', 'not-found', 'intercepted', 'error'.
export function categorizeError(err) {
  if (!err) return 'ok';
  const msg = String(err.message || err).toLowerCase();
  if (msg.includes('timeout')) return 'timeout';
  if (msg.includes('not found') || msg.includes('no element')) return 'not-found';
  if (msg.includes('intercept')) return 'intercepted';
  return 'error';
}

const OVERLAY_SELECTORS = [
  'button:has-text("Accept all")', 'button:has-text("Accept All")',
  'button:has-text("Accept")', 'button:has-text("I agree")',
  'button:has-text("I Agree")', 'button:has-text("Agree")',
  'button:has-text("Got it")', 'button:has-text("Got It")',
  'button:has-text("OK")', 'button:has-text("Allow")',
  '[class*="cookie" i][class*="accept" i]',
  '[class*="consent" i] button',
  '[id*="cookie" i] button',
  '[aria-label*="cookie" i][aria-label*="accept" i]',
  '[aria-label*="Cookie" i][aria-label*="dismiss" i]',
];

// Click common cookie/consent banners before the interaction pass so they do
// not intercept later clicks. Best-effort: every selector attempt is swallowed
// on failure. The optional `dispatch` callback lets tests stub the locator chain.
export async function dismissOverlays(page, dispatch) {
  const ask = dispatch || ((sel) => {
    const loc = page.locator(sel).first();
    return {
      isVisible: (opts) => loc.isVisible(opts),
      click: (opts) => loc.click(opts),
    };
  });
  for (const sel of OVERLAY_SELECTORS) {
    try {
      const h = await ask(sel);
      if (await h.isVisible({ timeout: 1000 })) {
        await h.click({ timeout: 2000 });
      }
    } catch { /* selector not found or not clickable; keep going */ }
  }
}

async function probeCount(context, url, timeoutSec) {
  const probe = await context.newPage();
  await probe.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutSec * 1000 });
  try { await probe.waitForLoadState('networkidle', { timeout: timeoutSec * 1000 }); } catch { /* tolerate */ }
  const total = await probe.locator(INTERACTION_SEL).count();
  await probe.close();
  return total;
}

// Fresh page per element + Locator API (re-resolves on each action, no stale handles).
// Cookie/consent overlays are dismissed before clicking so they do not intercept.
export async function interactionPass(context, url, timeoutSec, screenshotDir) {
  const total = await probeCount(context, url, timeoutSec);
  const count = Math.min(total, INTERACTION_CAP);
  const results = [];
  for (let i = 0; i < count; i++) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutSec * 1000 });
      try { await page.waitForLoadState('networkidle', { timeout: timeoutSec * 1000 }); } catch { /* tolerate */ }
      await dismissOverlays(page);

      const loc = page.locator(INTERACTION_SEL).nth(i);
      const selector = `${INTERACTION_SEL} >> nth=${i}`;
      let meta = { tag: null, role: null, name: '', href: null };
      try {
        meta = await loc.evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role'),
          name: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80),
          href: el.getAttribute('href'),
        }));
      } catch { /* metadata is best-effort */ }

      const beforeShot = join(screenshotDir, `interaction-${String(i + 1).padStart(2, '0')}-before.png`);
      try { await page.screenshot({ path: beforeShot }); } catch { /* ignore */ }
      const urlBefore = page.url();
      const clickErr = await loc.click({ timeout: CLICK_TIMEOUT_MS }).catch((e) => e);
      const isErr = clickErr instanceof Error;
      if (!isErr) await page.waitForTimeout(800);
      const afterUrl = page.url();
      const navigated = afterUrl !== urlBefore;
      const afterShot = join(screenshotDir, `interaction-${String(i + 1).padStart(2, '0')}-after.png`);
      try { await page.screenshot({ path: afterShot }); } catch { /* ignore */ }
      results.push({
        index: i + 1, selector, ...meta, navigated,
        result: isErr ? categorizeError(clickErr) : 'ok',
        error: isErr ? clickErr.message.split('\n')[0] : null,
        beforeShot, afterShot,
      });
    } finally {
      await page.close();
    }
  }
  return results;
}

// Fresh page per element. Hovers each clickable, waits for its CSS transition
// to complete (read from getComputedStyle), then screenshots before/after.
export async function hoverPass(context, url, timeoutSec, screenshotDir) {
  const total = await probeCount(context, url, timeoutSec);
  const count = Math.min(total, INTERACTION_CAP);
  const results = [];
  for (let i = 0; i < count; i++) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutSec * 1000 });
      try { await page.waitForLoadState('networkidle', { timeout: timeoutSec * 1000 }); } catch { /* tolerate */ }
      await dismissOverlays(page);

      const loc = page.locator(INTERACTION_SEL).nth(i);
      const selector = `${INTERACTION_SEL} >> nth=${i}`;
      const beforeShot = join(screenshotDir, `hover-${String(i + 1).padStart(2, '0')}-before.png`);
      try { await page.screenshot({ path: beforeShot }); } catch { /* ignore */ }

      const handle = await loc.elementHandle().catch(() => null);
      const hoverErr = await loc.hover({ timeout: CLICK_TIMEOUT_MS }).catch((e) => e);
      const isErr = hoverErr instanceof Error;
      let transitionMs = HOVER_FALLBACK_MS;
      if (!isErr && handle) {
        try {
          const ms = await page.evaluate((el) => {
            const s = getComputedStyle(el);
            return parseFloat(s.transitionDuration) * 1000 || 0;
          }, handle);
          if (Number.isFinite(ms) && ms > 0) transitionMs = ms;
        } catch { /* keep fallback */ }
        await page.waitForTimeout(transitionMs);
      }
      const afterShot = join(screenshotDir, `hover-${String(i + 1).padStart(2, '0')}-after.png`);
      try { await page.screenshot({ path: afterShot }); } catch { /* ignore */ }

      results.push({
        index: i + 1, selector, type: 'hover', transitionMs,
        result: isErr ? categorizeError(hoverErr) : 'ok',
        error: isErr ? hoverErr.message.split('\n')[0] : null,
        beforeShot, afterShot,
      });
    } finally {
      await page.close();
    }
  }
  return results;
}
