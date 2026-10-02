// states.mjs - what actually changes when an element is hovered, focused or pressed.
//
// Two ways to induce a state, and the difference matters for a clone:
//
//   real     a real pointer or a real focus(). The timing read off the element is
//            the timing a user sees. `timing` is a number.
//   forced   CDP CSS.forcePseudoState, for states no cursor can reach:
//            :focus-visible, :checked, :disabled, :focus-within. `timing` is
//            'unverified' only when no animation could be observed — see
//            measuredTiming() for why that is the exception and not the rule.
//
// The forced path was long assumed to apply the CSS without animating it, on the
// grounds that no real input event fires. Measured against Blink 1.62 / Chromium
// via CDP, that is wrong: forcing :hover on a 400ms transition produces a live
// `CSSTransition` whose `effect.getTiming().duration` is the declared 400, and
// sampling getComputedStyle over the window walks a continuous ramp from the
// start colour to the end one. So a forced state is measured whenever an
// animation is actually running, and is called 'unverified' only when it
// snapped with nothing running — which is the case that genuinely would lie.

/**
 * The duration of the animations the engine says are running on an element.
 *
 * Read from `getAnimations()` rather than from the stylesheet, because the point
 * is to distinguish an element that is genuinely animating from one that snapped
 * to its end value. A declared transition-duration is available either way and
 * proves nothing: a forced state that ignored its transition would still report
 * the declared number, and that number would be a lie.
 *
 * @param {import('playwright').Locator} handle
 * @returns {Promise<{duration: number, name: string|null, count: number}[]>}
 */
export async function measuredTiming(handle) {
  try {
    return await handle.evaluate((el) => el.getAnimations().map((a) => ({
      name: a.animationName || null,
      duration: a.effect?.getTiming?.().duration ?? null,
      count: 1,
    })));
  } catch {
    // No getAnimations, or the context went away mid-interaction.
    return [];
  }
}


/** Properties worth diffing. Filtered to the ones a designer would re-specify. */
export const STATE_PROPS = [
  'color', 'background-color', 'background-image', 'border-color', 'border-width',
  'border-radius', 'box-shadow', 'text-shadow', 'text-decoration-line', 'opacity',
  'transform', 'filter', 'outline-color', 'outline-width', 'outline-style',
];

/** The properties that decide how long an element takes to settle. */
export const TIMING_PROPS = ['transition-duration', 'transition-delay', 'animation-duration'];

/**
 * Milliseconds until an element has fully settled.
 *
 * `transition-duration` and `transition-delay` are comma-separated lists, so
 * `transition: opacity .3s, transform .5s` parses as "300ms" and screenshots the
 * element mid-flight. The answer is the slowest duration plus its own delay.
 * `animation-duration` counts too: an element mid-animation has not settled.
 *
 * @param {Record<string, string>} style a computed-style record
 * @returns {number}
 */
export function settleMs(style) {
  const durations = list(style['transition-duration']);
  const delays = list(style['transition-delay']);
  const worstTransition = Math.max(0, ...durations.map((d, i) => d + (delays[i] ?? delays[0] ?? 0)));
  const worstAnimation = Math.max(0, ...list(style['animation-duration']));
  return Math.max(worstTransition, worstAnimation);
}

function list(value) {
  return String(value || '0s')
    .split(',')
    .map((v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) ? (String(v).trim().endsWith('ms') ? n : n * 1000) : 0;
    });
}

/** Read the tracked properties off a live element. */
export async function readStyles(handle, props = STATE_PROPS) {
  return await handle.evaluate((el, names) => {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of names) out[p] = cs.getPropertyValue(p);
    return out;
  }, props);
}

/** Read just the settle timing off a live element. */
export async function readTiming(handle) {
  return await readStyles(handle, TIMING_PROPS);
}

/**
 * Wait until the element's own transitions and animations have finished.
 *
 * Sleeping for the declared duration is not the same thing: a transition starts
 * on the next frame, so reading at exactly its duration lands mid-flight and
 * records whatever interpolated value the machine happened to reach. The clock
 * is only the fallback for an element with nothing running.
 *
 * @param {import('playwright').Locator} handle
 * @param {import('playwright').Page} page
 * @param {number} fallbackMs
 */
export async function waitForAnimations(handle, page, fallbackMs) {
  try {
    await handle.evaluate(async (el, cap) => {
      const running = el.getAnimations({ subtree: true })
        // An infinite animation never settles, so waiting on it would hang the
        // capture. Its current frame is as good as anything.
        .filter((a) => a.playState !== 'finished'
          && a.effect?.getTiming().iterations !== Infinity);
      if (!running.length) return;
      await Promise.race([
        Promise.all(running.map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, cap)),
      ]);
    }, Math.max(200, fallbackMs * 4 + 200));
  } catch {
    // No getAnimations, or the context went away. The clock decides.
    await page.waitForTimeout(fallbackMs || 50);
  }
}

/**
 * Only the properties that actually changed, with both values kept.
 *
 * String inequality alone is too eager to be useful: the same colour arrives as
 * `#6366f1` and `rgb(99, 102, 241)` depending on where it was read from, and a
 * sub-pixel rounding difference reads as a state change that is not there. A
 * colour has to move 2 ΔE and a length 0.5px before it counts. Properties with no
 * meaningful unit — transform, filter, box-shadow — count on any difference,
 * because there is no small version of those.
 */
export function diffStyles(before, after) {
  const changed = {};
  for (const prop of Object.keys(after)) {
    if (before[prop] !== after[prop] && meaningfulChange(before[prop], after[prop])) {
      changed[prop] = { from: before[prop], to: after[prop] };
    }
  }
  return changed;
}

/** Smallest colour move worth reporting, in ΔE of the flat RGB triangle. */
const MIN_DELTA_E = 2;
/** Smallest length move worth reporting, in px. */
const MIN_LENGTH_PX = 0.5;

/** True when two computed values differ by more than rounding noise. */
export function meaningfulChange(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (ca && cb) {
    if (ca[3] !== cb[3]) return true; // alpha is a scalar, compare it directly
    const dist = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
    return dist >= MIN_DELTA_E;
  }
  const la = parseLength(a);
  const lb = parseLength(b);
  // Relative lengths are only comparable to each other: 1rem and 16px are the
  // same rendered length but there is no context-free way to convert one to the
  // other, so a rem-vs-px pair falls through to the "any difference" rule below
  // rather than being scored as a 15px change.
  if (la && lb && la.absolute && lb.absolute) {
    return Math.abs(la.px - lb.px) >= MIN_LENGTH_PX;
  }
  if (la && lb && la.unit === lb.unit) return Math.abs(la.px - lb.px) >= MIN_LENGTH_PX;
  return true; // unparseable on both sides: any difference is a real difference
}

/** `rgb(1, 2, 3)`, `rgba(1, 2, 3, .5)` and `#abc`/`#aabbcc`, else null. */
function parseColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  const fn = v.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const nums = parts.slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)));
    if (nums.some((n) => Number.isNaN(n))) return null;
    const alpha = parts[3] === undefined ? 1 : parseFloat(parts[3]);
    return [nums[0], nums[1], nums[2], Number.isNaN(alpha) ? 1 : alpha];
  }
  const hex = v.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return [
      parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
      h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    ];
  }
  return null;
}

/**
 * A CSS length as `{px, unit, absolute}`, or null.
 *
 * `px` is normalised for the absolute units only. `rem`/`em`/`vw`/`%` need the
 * font size or viewport they resolve against, which this module never measures,
 * so they keep their own unit and are only ever compared to like units.
 */
function parseLength(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|pt|pc|in|cm|mm|vw|vh|vmin|vmax|%)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const unit = (m[2] || 'px').toLowerCase();
  const scale = { px: 1, pt: 96 / 72, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[unit];
  return { px: n * (scale ?? 1), unit, absolute: scale !== undefined };
}

/**
 * Build one state record.
 *
 * `timing` is a number only where something was actually observed running. For a
 * forced state that is the measured animation duration when one was running, and
 * 'unverified' when the value arrived with nothing animating — the single case
 * where a declared duration would be a fabrication.
 *
 * @param {{selector: string, state: string, mode: 'real'|'forced', before: object,
 *          after: object, timing?: number, observed?: number, note?: string}} input
 */
export function stateEntry({ selector, state, mode, before, after, timing, observed, note }) {
  const changed = diffStyles(before, after);
  const measured = typeof observed === 'number' ? observed : null;
  return {
    selector,
    state,
    mode,
    // A measured duration is always preferred. The declared value is the CSS
    // `transition-duration`, which is what the clock falls back to when nothing
    // is running, not an observation — reporting it unqualified is how a
    // consumer ends up rebuilding a curve nobody watched run.
    timing: mode === 'forced' ? (measured ?? 'unverified') : (measured ?? timing ?? 0),
    timingSource: measured !== null ? 'measured' : (mode === 'forced' ? 'unverified' : 'declared'),
    changed,
    changedCount: Object.keys(changed).length,
    note: mode === 'forced'
      ? (note || (measured === null
        ? 'pseudo-state forced via CDP; no animation was running, so its duration is unknown'
        : 'pseudo-state forced via CDP; duration measured from the running animation'))
      // Only a caveat when there is something to caveat. `timingSource` is the
      // machine-readable answer; a confirmed measurement needs no prose.
      : (note ?? (measured === null
        ? 'no transition was running when this state was captured; timing is the declared CSS value, not an observed duration'
        : undefined)),
  };
}
