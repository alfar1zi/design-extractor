// states-pass.mjs - write states.json: every interactive element on the page,
// with what actually changes when it is hovered or focused.
//
// This runs on one already-loaded page. The interaction pass used to reload per
// element, which meant a menu opened by the previous element was gone by the time
// the next one was measured - the state was real, but not the page's.
//
// Hover and focus use real input, so the transition genuinely runs and the timing
// read off the element is the timing a user sees. :checked and :disabled have no
// cursor-driven equivalent, so those are forced over CDP and their duration is
// taken from the animation the engine actually started.

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openCdp } from './cdp.mjs';
import {
  readStyles, readTiming, settleMs, waitForAnimations, stateEntry, measuredTiming,
} from './states.mjs';

/** Anything a person can operate. Kept in the page: selectors are cheaper there. */
const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="checkbox"]', '[role="switch"]', '[role="option"]', '[role="combobox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Built as a string: a function passed to page.evaluate binds arguments by value. */
const SELECTOR_PROBE = `(() => {
  const { scope, limit } = JSON.parse(window.__deStatesProbe || '{"scope":[],"limit":40}');
  const out = [];
  const seen = new Set();
  // Walk up for a selector that actually resolves back to this element. An id is
  // worth the anchor; otherwise nth-of-type keeps siblings distinguishable.
  const sel = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const tag = n.tagName.toLowerCase();
      const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(sibs.length > 1 ? tag + ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')' : tag);
    }
    return parts.join(' > ');
  };
  for (const el of document.querySelectorAll(${JSON.stringify(INTERACTIVE)})) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (scope.length) {
      let inside = false;
      for (const s of scope) { try { if (el.closest(s)) { inside = true; break; } } catch {} }
      if (!inside) continue;
    }
    let selector;
    try { selector = sel(el); } catch { continue; }
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    // Only elements that can actually be checked: forcing :checked onto a button
    // matches no rule and reports a state change that does not exist.
    const role = el.getAttribute('role');
    const checkable = el.matches('input[type=checkbox],input[type=radio]')
      || ['checkbox', 'switch', 'radio', 'option', 'menuitemcheckbox'].includes(role);
    out.push({ selector, tag: el.tagName.toLowerCase(), role, checkable, disabled: !!el.disabled });
    if (out.length >= limit) break;
  }
  return out;
})()`;

/**
 * Read the per-property transition the page declares, for the ones that changed.
 *
 * Reported rather than assumed: a declared duration is what the stylesheet says
 * will happen, and the entry's `timing` is what was observed happening. A clone
 * needs both, and a page where they disagree is worth seeing.
 */
async function readTransitions(handle, changed) {
  // Not readTiming: that reads settle timing only, so asking it for
  // transition-property answers undefined and every entry came back empty.
  const cs = await readStyles(handle, [
    'transition-property', 'transition-duration', 'transition-timing-function',
  ]);
  const split = (v) => String(v || 'none').split(',').map((s) => s.trim());
  const props = split(cs['transition-property']);
  const durations = split(cs['transition-duration']);
  const easings = split(cs['transition-timing-function']);
  return Object.keys(changed)
    .filter((p) => props.includes(p))
    .map((p) => {
      const i = props.indexOf(p);
      return {
        property: p,
        duration: toMs(durations[i] ?? durations[0] ?? '0s'),
        easing: easings[i] ?? easings[0] ?? 'ease',
      };
    });
}
function toMs(value) {
  const m = String(value).trim().match(/^(-?[\d.]+)(ms|s)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === 's' ? n * 1000 : n;
}

/**
 * Return the page to a neutral baseline: nothing focused, cursor parked, and
 * every transition that was mid-flight allowed to land.
 * All three leak into the next capture otherwise. Focusing a <label for=x>
 * hands focus to its control, and blurring the label afterwards is a no-op
 * because the label was never the focused element, so #email stayed focused and
 * its :focus rule was reported under a ":hover" entry. Parking the cursor
 * clears :hover immediately but only starts the revert: a 300ms transition is
 * still interpolating when the baseline is read, and sampling mid-revert yields
 * a colour like rgb(106,98,230) that the page never actually settles on.
 */
async function reset(page, handle) {
  await page.evaluate(() => {
    const a = document.activeElement;
    if (a && a !== document.body && a.blur) a.blur();
  }).catch(() => {});
  await page.mouse.move(0, 0).catch(() => {});
  if (handle) await waitForAnimations(handle, page, settleMs(await readTiming(handle))).catch(() => {});
}

/** Capture one state by really performing it. Never throws: a page can move. */
async function captureReal(page, handle, selector, state, perform, restore) {
  try {
    await reset(page, handle);
    const before = await readStyles(handle);
    await perform();
    const running = await measuredTiming(handle);
    await waitForAnimations(handle, page, settleMs(await readTiming(handle)));
    const after = await readStyles(handle);
    // Read off the running animation, not off the declaration. When nothing was
    // running the declared value is still the clock this pass waited on, and
    // stateEntry labels it `declared` so it is not read as an observation.
    const observed = running.length ? Math.max(...running.map((a) => a.duration || 0)) : undefined;
    const entry = stateEntry({
      selector, state, mode: 'real', before, after, observed,
      timing: settleMs(await readTiming(handle)),
    });
    return { ...entry, transitions: await readTransitions(handle, entry.changed) };
  } catch {
    return null; // element scrolled away, covered, or the click opened a route
  } finally {
    await restore().catch(() => {});
  }
}

/**
 * Capture a state no cursor can reach, by forcing it over CDP.
 *
 * Blink animates these the same way it animates a real hover, so the duration is
 * read off the running animation rather than off the declaration. When nothing is
 * running the entry says so instead of quoting a number nobody observed.
 */
async function captureForced(cdp, nodeId, page, handle, selector, state, pseudo) {
  try {
    const before = await readStyles(handle);
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [pseudo] });
    const running = await measuredTiming(handle);
    await waitForAnimations(handle, page, settleMs(await readTiming(handle)));
    const after = await readStyles(handle);
    const observed = running.length ? Math.max(...running.map((a) => a.duration || 0)) : undefined;
    const entry = stateEntry({ selector, state, mode: 'forced', before, after, observed });
    return { ...entry, transitions: await readTransitions(handle, entry.changed) };
  } catch {
    return null;
  } finally {
    // Leaving a pseudo-state forced would silently change every later capture.
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
  }
}

/**
 * Write states.json.
 *
 * @param {import('playwright').Page} page an already-loaded page
 * @param {string} outDir
 * @param {{scope?: string[], limit?: number}} [opts] `scope` holds --target
 *   selectors; `limit` caps how many interactive elements are measured, because
 *   each one costs a real input event plus its full transition.
 */
export async function statesPass(page, outDir, { scope = [], limit = 40 } = {}) {
  await page.evaluate(`window.__deStatesProbe = ${JSON.stringify(JSON.stringify({ scope, limit: Number(limit) || 40 }))};`);
  const elements = await page.evaluate(SELECTOR_PROBE);

  // Detached in a finally below. Left attached, the DOM/CSS/Animation domains
  // stay live on the page for the rest of the run, and every later pass pays
  // for a session it never asked for.
  const cdp = await openCdp(page).catch(() => null);
  if (cdp) {
    await cdp.send('DOM.enable').catch(() => {});
    await cdp.send('CSS.enable').catch(() => {});
  }
  let rootId = null;
  const states = [];
  try {

  for (const el of elements) {
    const handle = await page.$(el.selector).catch(() => null);
    if (!handle) continue;

    // Restores park the cursor rather than re-hovering the element, which would
    // leave the next element's baseline reading the previous element's hover.
    const parked = () => page.mouse.move(0, 0).catch(() => {});
    const hovered = await captureReal(page, handle, el.selector, ':hover',
      () => handle.hover(), parked);
    if (hovered) states.push(hovered);

    const focused = await captureReal(page, handle, el.selector, ':focus',
      () => handle.focus(), () => reset(page, handle));
    if (focused) states.push(focused);

    if (cdp) {
      // No cursor reaches these two; a checkbox is checked by the user clicking a
      // label or pressing space, which would move focus and change more than the
      // state under test.
      for (const [state, pseudo, gate] of [[':checked', 'checked', el.checkable], [':disabled', 'disabled', el.disabled]]) {
        if (!gate) continue;
        if (!rootId) {
          const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
          rootId = root.nodeId;
        }
        const found = await cdp.send('DOM.querySelector', { nodeId: rootId, selector: el.selector }).catch(() => null);
        if (!found?.nodeId) continue;
        const forced = await captureForced(cdp, found.nodeId, page, handle, el.selector, state, pseudo);
        if (forced) states.push(forced);
      }
    }
  }
  } finally {
    if (cdp) await cdp.close().catch(() => {});
  }

  const out = {
    generatedAt: new Date().toISOString(),
    scope: scope.length ? scope : null,
    elementsMeasured: elements.length,
    states,
    counts: {
      total: states.length,
      withChanges: states.filter((s) => s.changedCount > 0).length,
      // "verified" means observed, not merely numeric: a declared CSS duration
      // is a number too, and counting it as verified is the claim this split
      // exists to prevent.
      verifiedTiming: states.filter((s) => s.timingSource === 'measured').length,
      declaredTiming: states.filter((s) => s.timingSource === 'declared').length,
      unverifiedTiming: states.filter((s) => s.timingSource === 'unverified').length,
    },
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'states.json'), JSON.stringify(out, null, 2));
  return out.counts;
}