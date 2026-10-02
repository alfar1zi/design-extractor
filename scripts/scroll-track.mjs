/**
 * Scroll-linked motion: what moves as the page scrolls, and when.
 *
 * A sampler that only watches from load cannot see this. A sticky header, a
 * parallax layer and a fade-on-enter all sit perfectly still at scrollY 0 and
 * only reveal themselves under motion, so the tracks a clone needs are exactly
 * the ones a load-time sampler misses.
 */

/**
 * A selector that still names the same element after the page has scrolled and
 * other nodes have mounted. `id` when there is one, otherwise the nth-child
 * path, because tag.class collides the moment a page reuses a component.
 */
const SELECTOR_HELPER = `
  const deSel = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const tag = n.tagName.toLowerCase();
      const parent = n.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const i = Array.prototype.indexOf.call(parent.children, n) + 1;
      parts.unshift(tag + ':nth-of-type(' + i + ')');
    }
    return parts.join(' > ');
  };
`;

/**
 * Walk down in scroll increments, recording the transform and opacity of every
 * element that actually moved between one stop and the next.
 *
 * Elements that did not move are dropped rather than reported as unchanged. A
 * clone replaying this wants the list of things that react to scroll, and a
 * per-step snapshot of the whole viewport would bury that under the page
 * furniture that stayed exactly where it was.
 *
 * @param {import('playwright').Page} page an already-loaded page
 * @param {{steps?: number, scope?: string[], settleMs?: number, maxPerStep?: number}} [opts]
 *   `steps` increments of 0.8 viewport each; `scope` holds the --target selectors.
 * @returns {Promise<Array<{scrollY: number, entries: Array<{selector: string, transform: string, opacity: string}>}>>}
 */
export async function sampleScrollTrack(page, {
  steps = 8, scope = [], settleMs = 120, maxPerStep = 80,
} = {}) {
  const raw = await page.evaluate(`(async () => {
    const steps = ${JSON.stringify(steps)};
    const scope = ${JSON.stringify(scope)};
    const settleMs = ${JSON.stringify(settleMs)};
    const maxPerStep = ${JSON.stringify(maxPerStep)};
    ${SELECTOR_HELPER}

    let roots = null;
    const inScope = (el) => {
      if (!scope.length) return true;
      if (!roots) {
        roots = [];
        for (const s of scope) {
          try { roots.push(...document.querySelectorAll(s)); } catch { /* not a valid selector */ }
        }
      }
      for (const r of roots) if (r === el || r.contains(el)) return true;
      return false;
    };

    const height = window.innerHeight || 1;
    const startY = window.scrollY || 0;
    const movers = new Map();
    const last = new Map();
    const out = [];
    // Walking every element and reading its style takes longer than a typical
    // transition, so by the time the walk reaches an element it has landed and
    // only the end state is left. The start value is read off the running
    // animation the moment it starts, which is the only moment it exists.
    const starts = new Map();
    const noteStart = (event) => {
      const el = event.target;
      if (!el || el.nodeType !== 1) return;
      const selector = deSel(el);
      if (!selector) return;
      // One event per property, and each animation's first keyframe only carries
      // its own property. Overwriting made the pair arrive half empty, so they
      // are merged instead of replaced.
      const record = starts.get(selector) || {};
      for (const a of (el.getAnimations ? el.getAnimations() : [])) {
        const frames = a.effect && a.effect.getKeyframes ? a.effect.getKeyframes() : null;
        if (!frames || !frames.length) continue;
        if (frames[0].transform !== undefined) record.transform = frames[0].transform;
        if (frames[0].opacity !== undefined) record.opacity = frames[0].opacity;
      }
      if (record.transform !== undefined || record.opacity !== undefined) starts.set(selector, record);
    };
    document.addEventListener('transitionrun', noteStart, true);
    document.addEventListener('animationstart', noteStart, true);

    for (let i = 0; i <= steps; i++) {
      const y = Math.round(i * 0.8 * height);
      starts.clear();
      window.scrollTo(0, y);
      // Scroll-driven work is settled on the next frames, not synchronously.
      await new Promise((r) => setTimeout(r, settleMs));
      // Then let what this scroll started finish landing. Reading mid-transition
      // files the same element at every stop on the ramp, so one fade-in turns
      // into four rows and the report reads as four separate movers.
      await Promise.race([
        Promise.all(document.getAnimations()
          .filter((a) => !(a.effect && a.effect.getTiming().iterations === Infinity))
          .map((a) => a.finished.catch(() => {}))),
        new Promise((r) => setTimeout(r, 2000)),
      ]);


      const heightNow = window.innerHeight || height;
      const entries = [];
      const seen = new Set();
      // Stop zero reads the whole document, visible or not. A panel that is still
      // below the fold when the walk starts has to already have a baseline, or
      // the first time it is on screen it looks like a first sighting and the
      // fade-in that follows goes unreported.
      const baseline = i === 0;
      for (const el of document.querySelectorAll('*')) {
        const selector = deSel(el);
        if (!selector) continue;
        const box = el.getBoundingClientRect();
        if (!baseline) {
          // Anything that moved before keeps being sampled even once it scrolls
          // out of view: a sticky header leaves the viewport and still tracks.
          const onScreen = box.bottom > -heightNow && box.top < heightNow * 2;
          if (!onScreen && !movers.has(selector)) continue;
        }
        if (!inScope(el)) continue;

        const cs = getComputedStyle(el);
        const key = cs.transform + '|' + cs.opacity;
        // The map is the running state of every sampled element, so an element
        // that holds still compares against itself at the next stop instead of
        // against nothing. Only the diff becomes an entry.
        const previous = last.get(selector);
        last.set(selector, key);
        seen.add(selector);
        // A first sighting is not a change. An element that scrolls into view for
        // the first time has no earlier value to differ from, and reporting it
        // buried the real movers under every panel that merely came on screen.
        if (previous === undefined || previous === key) continue;
        movers.set(selector, true);
        // Read off the animation recorded when it started, not here: by now it
        // has finished and its keyframes are gone.
        const from = starts.get(selector) || null;
        entries.push({
          selector,
          transform: cs.transform,
          opacity: cs.opacity,
          from,
          top: Math.round(box.top),
        });
        if (entries.length >= maxPerStep) break;
      }
      // Once a mover is out of reach it is forgotten entirely, so it cannot
      // accumulate one entry per stop for the rest of the walk.
      for (const selector of [...movers.keys()]) {
        if (!seen.has(selector)) { movers.delete(selector); last.delete(selector); }
      }
      out.push({ scrollY: window.scrollY, entries });
    }

    window.scrollTo(0, startY);
    return out;
  })()`).catch(() => []);

  // An empty track is not a page that does not move on scroll, it is a page the
  // walk never happened on. Say which one it was so a consumer can tell.
  return raw.length ? raw : [];
}
