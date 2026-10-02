// unproducible-pass.mjs - name the parts of a page a rebuild cannot reproduce,
// per element, and photograph each one.
//
// The page-level list in unproducible.mjs says "this page has canvases". That is
// not enough to act on when a page has thirty of them. This walks the actual
// elements, says why each one cannot be turned into DOM and CSS, and leaves a
// screenshot of the exact box behind so the rebuild has something to match
// against rather than a label to guess from.

const SCAN = `
  (scope) => {
    const path = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
        if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
        const parent = n.parentElement;
        const i = parent ? Array.prototype.indexOf.call(parent.children, n) + 1 : 1;
        parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      }
      return parts.join(' > ');
    };
    const inScope = (el) => {
      if (!scope.length) return true;
      for (const sel of scope) {
        for (const root of document.querySelectorAll(sel)) {
          if (root === el || root.contains(el)) return true;
        }
      }
      return false;
    };
    // A region with no paint of its own behind it and no text of its own is
    // usually something the capture never reached rather than something
    // deliberately opaque, and those are not the same finding.
    const hasOwnPaint = (el) => {
      const cs = getComputedStyle(el);
      return cs.backgroundImage !== 'none' || cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
    };
    // Matched against the element's OWN text, not its subtree's. Every ancestor
    // of a sign-in prompt contains the same words, so matching on textContent
    // flagged the whole page section as gated and photographed it twice.
    const SIGN_IN = /(^|[^a-z])(sign in|log ?in|login|register|subscribe to continue)([^a-z]|$)/i;
    const ownText = (el) => {
      let out = '';
      for (const n of el.childNodes) if (n.nodeType === 3) out += n.nodeValue + ' ';
      return out.trim();
    };

    const out = [];
    const push = (el, reason, extra) => {
      if (!inScope(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      out.push({
        selector: path(el),
        reason,
        tag: el.tagName.toLowerCase(),
        box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        ...extra,
      });
    };

    for (const c of document.querySelectorAll('canvas')) {
      const kinds = (typeof window.__deCanvasContexts === 'function') ? window.__deCanvasContexts(c) : [];
      const webgl = kinds.some((k) => k === 'webgl' || k === 'webgl2');
      if (!kinds.length) continue;
      push(c, webgl ? 'webgl' : 'canvas2d', { contexts: kinds });
    }
    for (const v of document.querySelectorAll('video')) push(v, 'video', {});
    for (const f of document.querySelectorAll('iframe')) {
      let crossOrigin = false;
      try { crossOrigin = new URL(f.src, location.href).origin !== location.origin; } catch { crossOrigin = true; }
      push(f, 'iframe', { crossOrigin, src: f.getAttribute('src') || null });
    }

    // An empty region is only a finding when something was clearly meant to be
    // there. A plain <div> with no paint and no text is just a div.
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('canvas, video, iframe')) continue;
      const text = (el.textContent || '').trim();
      if (SIGN_IN.test(ownText(el)) && !el.querySelector('form')) {
        push(el, 'auth-gated', { text: text.slice(0, 120) });
      } else if (!text && !hasOwnPaint(el) && el.getBoundingClientRect().height > 60) {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg.includes('url(')) push(el, 'missing-asset', { background: bg.slice(0, 160) });
      }
    }
    return out;
  }
`;

/**
 * @param {import('playwright').Page} page
 * @param {{scope?: string[], shotDir?: string, screenshots?: boolean}} [opts]
 * @returns {Promise<{count: number, items: Array<object>, crossOriginSheets: string[]}>}
 */
export async function findUnreproducible(page, { scope = [], shotDir = null, screenshots = true } = {}) {
  const found = await page.evaluate(`(${SCAN})(${JSON.stringify(scope)})`).catch(() => []);

  const items = [];
  for (const item of found) {
    let screenshot = null;
    if (screenshots && shotDir) {
      // Playwright scrolls the element into view before it shoots, so the clip is
      // taken against the element and not against whatever the scan found at
      // those coordinates. The recorded box stays the position at scan time.
      const abs = `${shotDir}/unreproducible/${item.reason.replace(/[^a-z0-9]+/gi, '-')}-${items.length}.png`;
      const shot = await page.locator(item.selector).first().screenshot({ path: abs }).catch(() => null);
      screenshot = shot ? abs.split('/').pop() : null;
    }
    items.push({ ...item, screenshot });
  }

  // Reading `cssRules` is the only reliable test: the browser throws
  // SecurityError for a sheet served from another origin and succeeds for a
  // same-origin one, including one this run inlined. Skipping this makes
  // `complete: true` on the page a claim nobody checked.
  const crossOriginSheets = await page.evaluate(() => {
    const out = [];
    for (const sheet of document.styleSheets) {
      try { void sheet.cssRules; } catch { out.push(sheet.href || '(inline, blocked)'); }
    }
    return out;
  }).catch(() => []);

  return { count: items.length, items, crossOriginSheets };
}