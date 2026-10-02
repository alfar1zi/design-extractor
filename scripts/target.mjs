// target.mjs - capture one element instead of the whole page.
//
// A user pointing at `.pricing-card` wants that card, not a 2400-element tree
// with the card somewhere inside it. The unit captured here is self-contained:
// the markup, the computed styles that make it look the way it does, the states
// it goes through, and a screenshot cropped to it. Everything a rebuild of
// that one element needs, and nothing that is only interesting because it
// happened to share a page with it.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readStyles, readTiming, settleMs, stateEntry, waitForAnimations } from './states.mjs';

// CSS property names, not JS ones. getPropertyValue('backgroundColor') returns
// an empty string, which silently turned every state diff into "nothing changed".
const PROPS = [
  'display', 'position', 'inset', 'z-index', 'flex-direction', 'gap', 'align-items', 'justify-content',
  'grid-template-columns', 'width', 'height', 'min-height', 'max-width', 'margin', 'padding',
  'box-sizing', 'overflow', 'border-radius', 'border-width', 'border-style', 'border-color',
  'background-color', 'background-image', 'box-shadow', 'opacity', 'transform', 'transition',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'text-align',
  'object-fit', 'filter', 'backdrop-filter', 'mix-blend-mode',
];

/** Read inside the page. Computed values are what a rebuild must match. */
export const TARGET_PROBE_SOURCE = `(${function probeTarget(selector, props) {
  const el = document.querySelector(selector);
  if (!el) return { found: false, matches: 0 };
  const matches = document.querySelectorAll(selector).length;
  const cs = getComputedStyle(el);
  const styles = {};
  for (const p of props) styles[p] = cs.getPropertyValue(p) || cs[p];
  const r = el.getBoundingClientRect();
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const box = el.getBoundingClientRect();
  return {
    found: true, matches,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classList: [...el.classList],
    role: el.getAttribute('role'),
    rect: { width: Math.round(r.width), height: Math.round(r.height) },
    box: { x: Math.round(box.x), y: Math.round(box.y) },
    styles,
    html: el.outerHTML,
    childCount: el.children.length,
    text: (el.innerText || '').trim().slice(0, 400),
  };
}})`;

/**
 * Capture every element matching each selector.
 *
 * A selector that matches nothing is reported, not thrown: one stale selector
 * out of three should not lose the other two captures.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {string} outDir
 */

/**
 * Resolve the --target selectors against the live page.
 *
 * A run where every selector matches nothing is almost always a typo, and it is
 * worth catching before the expensive passes rather than after: the output
 * directory would otherwise fill with artifacts scoped to nothing, which reads
 * exactly like a successful run. One bad selector out of several is not fatal —
 * targetPass reports that case per selector.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @returns {Promise<{selector: string, matches: number, error: string|null}[]>}
 */
export async function resolveTargets(page, selectors) {
  return await page.evaluate((sels) => sels.map((selector) => {
    try {
      return { selector, matches: document.querySelectorAll(selector).length, error: null };
    } catch (e) {
      return { selector, matches: 0, error: e.message.split('\n')[0] };
    }
  }), selectors);
}

export async function targetPass(page, selectors, outDir) {
  const targets = [];
  for (const selector of selectors) {
    const handle = page.locator(selector).first();
    if (await handle.count() === 0) {
      targets.push({ selector, found: false, reason: 'no element matches this selector' });
      continue;
    }
    await page.evaluate(`window.__deTarget = ${TARGET_PROBE_SOURCE}`);
    const probe = await page.evaluate(([sel, names]) => window.__deTarget(sel, names), [selector, PROPS]);
    await page.evaluate('delete window.__deTarget').catch(() => {});

    const timing = await readTiming(handle).catch(() => null);
    const states = [];
    for (const pseudo of ['hover', 'focus']) {
      const before = await readStyles(handle, PROPS);
      if (pseudo === 'hover') await handle.hover().catch(() => {});
      else await handle.focus().catch(() => {});
      // Waiting exactly settleMs reads the style mid-transition, so `after` is
      // whatever frame the machine happened to land on. Ask the running
      // animations to finish, and fall back to the clock when there are none.
      await waitForAnimations(handle, page, settleMs(timing));
      states.push(stateEntry({
        selector, state: pseudo, mode: 'real', before,
        after: await readStyles(handle, PROPS),
        timing: settleMs(timing),
      }));
      await page.mouse.move(0, 0);
      await handle.evaluate((el) => el.blur()).catch(() => {});
    }

    // Numbered by how many shots have already landed, not by how many selectors
    // matched. A match with no box takes a number it never uses, and the gap
    // makes a reader hunt for a file that was never written.
    const file = `target-${targets.filter((t) => typeof t.screenshot === 'string').length + 1}.png`;
    // A matched element can still have no box to photograph: a visually hidden
    // link inside a footer is a real match with nothing to look at. Saying why
    // beats a null the reader has to guess at.
    const shot = await handle.screenshot({ path: join(outDir, 'targets', file) })
      .then(() => file)
      .catch((e) => ({ error: e.message.split('\n')[0] }));
    targets.push({ selector, ...probe, states, screenshot: shot });
  }

  const found = targets.filter((t) => t.found);
  const shots = found.filter((t) => typeof t.screenshot === 'string').length;
  await writeFile(join(outDir, 'targets.json'), JSON.stringify({
    selectors, count: found.length, shots, missing: targets.length - found.length, targets,
  }, null, 2));
  return { found: found.length, missing: targets.length - found.length, shots };
}