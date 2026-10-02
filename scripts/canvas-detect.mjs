// canvas-detect.mjs - detect canvas elements and WebGL contexts in a page.
//
// The earlier version asked each canvas for a webgl context to find out whether
// it had one. That mutates the page: a canvas with no context yet is given one,
// and a canvas type is locked on first use, so a page whose own script calls
// getContext later gets null back and draws nothing. The capture then reports a
// WebGL canvas on a page that is plainly broken by the tool that looked at it.
//
// So the contexts are recorded instead of requested. A recorder is installed
// before the first navigation and wraps getContext to note what each canvas was
// asked for. Nothing here calls getContext at all, so the page is untouched.

/** Wraps getContext so the capture can see what each canvas was given. */
const CANVAS_RECORDER = `
  (() => {
    const made = new WeakMap();
    const native = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = native.call(this, type, ...rest);
      if (ctx) {
        const known = made.get(this) || [];
        if (!known.includes(type)) made.set(this, known.concat(type));
      }
      return ctx;
    };
    window.__deCanvasContexts = (el) => (made.get(el) || []).slice();
  })();
`;

/**
 * Record which context types each canvas was actually given.
 *
 * The type is reported as unknown when the recorder was not installed rather
 * than guessed: the only way to find out by asking is to create a context, and
 * a canvas type is locked on first use, so asking can leave a page that can no
 * longer draw into its own canvas.
 */
export async function installCanvasRecorder(page) {
  await page.addInitScript(CANVAS_RECORDER);
}

/**
 * Describe every canvas on the page without touching it.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{width: number, height: number, id: string|null,
 *   className: string|null, hasWebGL: boolean, contexts: string[], contextKnown: boolean,
 *   selector: string, box: object}>>}
 */
export async function detectCanvas(page) {
  return await page.evaluate(() => {
    const recorded = typeof window.__deCanvasContexts === 'function';
    const cssPath = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
        if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
        const i = Array.prototype.indexOf.call(n.parentElement ? n.parentElement.children : [n], n) + 1;
        parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      }
      return parts.join(' > ');
    };

    // No recorder: the canvases are still reported, but their context type is
    // not guessed. Asking is what breaks the page.
    return Array.from(document.querySelectorAll('canvas')).map((c) => {
      const contexts = recorded ? window.__deCanvasContexts(c) : [];
      const r = c.getBoundingClientRect();
      return {
        width: c.width,
        height: c.height,
        id: c.id || null,
        className: c.className || null,
        hasWebGL: recorded && contexts.some((t) => t === 'webgl' || t === 'webgl2'),
        contexts,
        contextKnown: recorded,
        selector: cssPath(c),
        box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      };
    });
  });
}