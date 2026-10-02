// unproducible.mjs - state plainly what a rebuild cannot reproduce.
//
// This file exists because a capture that silently omits half the page reads as
// a complete one. Every entry here names something the capture saw but could
// not turn into DOM, CSS or JS a clone could use. An empty list means the page
// genuinely had none of these, not that the extractor forgot to look.

// Every key here is a condition `collectUnproducible` can actually be given.
// A catalog entry nothing sets is worse than a missing one: it reads as a
// guarantee that the capture looks for that thing.
export const REASONS = {
  canvas: 'Rendered into a canvas or WebGL context. The output is pixels with no DOM or CSS behind it.',
  crossOriginStylesheet: 'A stylesheet served from another origin. The browser refuses to expose its rules, so only its effects are visible.',
  truncatedMotion: 'Motion sampling hit its cap. Some animated elements were not sampled for the whole window.',
  unminifiedName: 'A component the framework confirmed but whose name the production build minified away.',
};

/**
 * Collect everything the capture could not reproduce.
 *
 * Two page-level conditions were catalogued here and never wired to a caller,
 * so neither could ever appear in a capture:
 *
 * - `closedShadowRoot`. Measured, not assumed: CDP reads a `mode: 'closed'`
 *   root via `DOM.getDocument({depth: -1, pierce: true})`, and the text inside
 *   it reaches the capture. Reporting it as unreproducible told consumers to
 *   give up on something the extractor can already rebuild.
 * - `videos`. The per-element scan already emits a `video` finding with a
 *   selector, a box and a cropped screenshot, which says more than a count.
 *
 * @param {object} input
 * @param {Array<object>} [input.canvasInfo]
 * @param {boolean} [input.truncatedMotion]
 * @param {number} [input.unnamedComponents]
 * @param {Array<string>} [input.crossOriginSheets] hrefs whose `cssRules` threw
 */
export function collectUnproducible({
  canvasInfo = [],
  truncatedMotion = false,
  unnamedComponents = 0,
  crossOriginSheets = [],
} = {}) {
  const items = [];

  for (const c of canvasInfo) {
    items.push({ reason: 'canvas', count: 1, detail: c, note: REASONS.canvas });
  }
  for (const href of crossOriginSheets) {
    items.push({ reason: 'crossOriginStylesheet', count: 1, detail: { href }, note: REASONS.crossOriginStylesheet });
  }
  if (truncatedMotion) {
    items.push({ reason: 'truncatedMotion', count: 1, detail: null, note: REASONS.truncatedMotion });
  }
  if (unnamedComponents > 0) {
    items.push({
      reason: 'unminifiedName',
      count: unnamedComponents,
      detail: null,
      note: `${REASONS.unminifiedName} The boundary was still found; only the name is missing.`,
    });
  }

  return {
    complete: items.length === 0,
    count: items.length,
    items,
    howToRead: items.length === 0
      ? 'Nothing the capture could not represent was found on this page.'
      : 'Each item is something this capture saw and could not turn into rebuildable DOM, CSS or JS.',
  };
}