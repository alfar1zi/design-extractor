// interaction-pass.mjs - element-level interaction capture using Playwright Locator API.
// Extracted from inspect.mjs so the orchestrator stays under the AGENTS.md 400-line cap.
import { join } from 'node:path';
import { readStyles, readTiming, settleMs, stateEntry, waitForAnimations } from './states.mjs';

export const CLICK_CAP = 50;
export const INTERACTIVE_CAP = 200;
export const STABLE_INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'combobox']);

// Walk an a11y tree and return nodes that look clickable AND stable (named + interactive role).
export function selectClickables(a11yTree) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    const role = (node.role || '').toLowerCase();
    if (STABLE_INTERACTIVE_ROLES.has(role) && (node.name || node.ariaLabel || node.value)) {
      out.push({ role, name: node.name || node.ariaLabel || node.value || '' });
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  walk(a11yTree);
  return out.slice(0, CLICK_CAP);
}

// Bug 4 fix: extract only interactive elements (not the full recursive tree).
// Accepts a serialized a11y-tree node OR a DOM-snapshot array of plain objects.
export function extractInteractiveElements(root) {
  const results = [];
  const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea']);
  const walk = (node) => {
    if (!node || results.length >= INTERACTIVE_CAP) return;
    const role = (node.role || '').toLowerCase();
    const tag = (node.tag || '').toLowerCase();
    const isInteractive = (
      STABLE_INTERACTIVE_ROLES.has(role) ||
      INTERACTIVE_TAGS.has(tag) ||
      node.href ||
      node.tabIndex >= 0
    );
    if (isInteractive) {
      results.push({
        tag: tag || null,
        role: role || null,
        name: (node.name || node.ariaLabel || node.alt || node.title || '').slice(0, 80),
        href: node.href || null,
        value: node.value || null,
        outerHTML: node.outerHTML ? node.outerHTML.slice(0, 200) : null,
      });
    }
    const children = node.children || [];
    for (const c of children) walk(c);
  };
  walk(root);
  return results;
}

export const INTERACTION_CAP = 20;
export const INTERACTION_SEL = 'a[href], button:not([disabled]), [role="button"]:not([disabled]), input[type="submit"], [tabindex="0"]';
const CLICK_TIMEOUT_MS = 8000;
const HOVER_FALLBACK_MS = 800;
// Cap the per-element page load well below the inspect --timeout default (30s) so 20 elements
// do not blow past 5 minutes on slow SPAs.
const PER_PAGE_GOTO_MS = 15000;

/** The CLI's --timeout, which is a navigation deadline and not a per-element one. */
function gotoTimeout(timeoutSec) {
  return timeoutSec ? timeoutSec * 1000 : PER_PAGE_GOTO_MS;
}

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

/** Load and let a SPA hydrate. networkidle hangs on long-poll pages. */
async function loadPage(page, url, gotoMs) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoMs });
  await page.waitForTimeout(800);
}

async function probeCount(context, url, gotoMs) {
  const probe = await context.newPage();
  await probe.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoMs });
  // SPA hydration wait; replaces networkidle which hangs on long-poll pages.
  await probe.waitForTimeout(800);
  const total = await probe.locator(INTERACTION_SEL).count();
  await probe.close();
  return total;
}

// One page for the whole sweep, reloaded only when a click actually navigated.
// The Locator API re-resolves on each action, so there are no stale handles; the
// reload is what keeps nth=i meaning the same element, because after a
// navigation the list is a different list entirely. Cookie/consent overlays are
// dismissed before each click so they do not intercept.
export async function interactionPass(context, url, timeoutSec, screenshotDir) {
  // The caller's --timeout, not a constant. A hardcoded one silently made the
  // flag do nothing and turned any slow-loading site into a failed capture.
  const gotoMs = gotoTimeout(timeoutSec);
  const total = await probeCount(context, url, gotoMs);
  const count = Math.min(total, INTERACTION_CAP);
  const results = [];
  const page = await context.newPage();
  try {
    await loadPage(page, url, gotoMs);
    for (let i = 0; i < count; i++) {
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

      const handle = await loc.elementHandle().catch(() => null);
      const before = handle ? await readStyles(handle).catch(() => null) : null;
      // Focus is captured before the click, because a click navigates and the
      // element is gone by the time anything could be read back.
      let focusState = null;
      if (before) {
        await loc.focus({ timeout: CLICK_TIMEOUT_MS }).catch(() => {});
        const focusTiming = settleMs(await readTiming(handle).catch(() => ({})));
        if (Number.isFinite(focusTiming) && focusTiming > 0) {
          await waitForAnimations(handle, page, focusTiming);
        }
        const focused = await readStyles(handle).catch(() => null);
        if (focused) {
          focusState = stateEntry({ selector, state: ':focus', mode: 'real', before, after: focused, timing: focusTiming });
        }
        await handle.dispose().catch(() => {});
      }

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
        index: i + 1, selector, ...meta, navigated, focusState,
        result: isErr ? categorizeError(clickErr) : 'ok',
        error: isErr ? clickErr.message.split('\n')[0] : null,
        beforeShot, afterShot,
      });

      // Only a real navigation breaks the index-to-element mapping. Reloading
      // unconditionally would put the pass back to one load per element.
      if (navigated && i < count - 1) await loadPage(page, url, gotoMs);
    }
  } finally {
    await page.close();
  }
  return results;
}

// One page for the whole sweep. Hovering never navigates, so a fresh load per
// element bought nothing and cost a full page load each time -- on a twenty
// element page that was most of the pass's wall clock spent on navigation.
export async function hoverPass(context, url, timeoutSec, screenshotDir) {
  const gotoMs = gotoTimeout(timeoutSec);
  const total = await probeCount(context, url, gotoMs);
  const count = Math.min(total, INTERACTION_CAP);
  const results = [];
  const page = await context.newPage();
  try {
    await loadPage(page, url, gotoMs);
    for (let i = 0; i < count; i++) {
      // Dismissed per element, not once: a hover can open a menu that covers the
      // next target, and a later element behind it would fail for that reason.
      await dismissOverlays(page);

      const loc = page.locator(INTERACTION_SEL).nth(i);
      const selector = `${INTERACTION_SEL} >> nth=${i}`;
      const beforeShot = join(screenshotDir, `hover-${String(i + 1).padStart(2, '0')}-before.png`);
      try { await page.screenshot({ path: beforeShot }); } catch { /* ignore */ }

      const handle = await loc.elementHandle().catch(() => null);
      const before = handle ? await readStyles(handle).catch(() => null) : null;
      const hoverErr = await loc.hover({ timeout: CLICK_TIMEOUT_MS }).catch((e) => e);
      const isErr = hoverErr instanceof Error;
      let timingMs = 0;
      let state = null;
      if (!isErr && handle) {
        // Read the timing AFTER the hover, so it is the hover state's own timing.
        // parseFloat on `transition-duration` would take only the first value of
        // the list and screenshot the element while the slower half still ran.
        const declared = settleMs(await readTiming(handle).catch(() => ({})));
        timingMs = Number.isFinite(declared) ? declared : 0;
        // The wait and the reported timing are different things. An element with
        // no declared transition still gets time for a JS-driven settle, but it
        // must not be reported as animating for however long we happened to wait.
        await waitForAnimations(handle, page, timingMs > 0 ? timingMs : HOVER_FALLBACK_MS);
        if (before) {
          const after = await readStyles(handle).catch(() => null);
          if (after) state = stateEntry({ selector, state: ':hover', mode: 'real', before, after, timing: timingMs });
        }
        await handle.dispose().catch(() => {});
      }
      const afterShot = join(screenshotDir, `hover-${String(i + 1).padStart(2, '0')}-after.png`);
      try { await page.screenshot({ path: afterShot }); } catch { /* ignore */ }

      results.push({
        index: i + 1, selector, type: 'hover', transitionMs: timingMs, state,
        result: isErr ? categorizeError(hoverErr) : 'ok',
        error: isErr ? hoverErr.message.split('\n')[0] : null,
        beforeShot, afterShot,
      });
    }
  } finally {
    await page.close();
  }
  return results;
}
