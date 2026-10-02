// component-detail.mjs - make each component entry rebuildable on its own.
//
// A name and a confidence score is a lookup table. What a rebuild actually needs
// is the thing itself: the markup, the resolved styles, and which stylesheet
// each rule came from. Someone reopening the artifact never opens a browser, so
// anything not written here is gone by the time they need it.
//
// The probe runs as a second pass, after the component probe has already turned
// live elements into selectors. One pass per source of truth: that pass reads
// framework state, this one reads the DOM, and neither has to know about the
// other's shape.

/** The properties a state pass also samples, so both artifacts agree on a shape. */
export const DETAIL_PROPS = [
  'background-color', 'color', 'border-color', 'box-shadow', 'transform',
  'opacity', 'text-decoration-line', 'outline', 'filter', 'width', 'height',
];

/** Run inside the page. Reads computed styles and matched rules; writes nothing. */
export const DETAIL_PROBE_SOURCE = `(${function probeDetail(opts) {
  const { props, maxHtml = 4000, maxRules = 12 } = opts || {};
  const out = {};

  // Cross-origin stylesheets throw SecurityError on cssRules, which is the whole
  // reason the CDP pass exists for keyframes. For matched rules there is no such
  // escape hatch here, so the failure is recorded as a number rather than
  // silently producing a component with no rules at all.
  let sheetsRead = 0;
  let sheetsBlocked = 0;
  for (const selector of opts.selectors || []) {
    let el = null;
    try { el = document.querySelector(selector); } catch { el = null; }
    if (!el) { out[selector] = { missing: true }; continue; }

    const cs = getComputedStyle(el);
    const computed = {};
    for (const p of props) computed[p] = cs.getPropertyValue(p).trim();

    const rules = [];
    for (const sheet of document.styleSheets) {
      let rulesList;
      try { rulesList = sheet.cssRules; } catch { sheetsBlocked++; continue; }
      if (!rulesList) continue;
      sheetsRead++;
      for (const rule of rulesList) {
        if (rules.length >= maxRules) break;
        // Only CSSStyleRule can match an element; @media and @keyframes cannot.
        if (!rule.selectorText || !rule.style) continue;
        let matches = false;
        try { matches = el.matches(rule.selectorText); } catch { matches = false; }
        if (!matches) continue;
        rules.push({
          selector: rule.selectorText,
          href: sheet.href || 'inline',
          cssText: rule.cssText.length > 400 ? rule.cssText.slice(0, 400) : rule.cssText,
        });
      }
    }

    out[selector] = {
      outerHTML: el.outerHTML.length > maxHtml ? el.outerHTML.slice(0, maxHtml) : el.outerHTML,
      truncatedHtml: el.outerHTML.length > maxHtml,
      classNames: [...el.classList],
      computed,
      rules,
    };
  }
  return { detail: out, sheetsRead, sheetsBlocked };
}})`;

/**
 * Attach markup, resolved styles and matched rules to component entries.
 *
 * @param {import('playwright').Page} page
 * @param {object[]} components authoritative component entries
 * @param {{maxHtml?: number, maxRules?: number}} [opts]
 */
export async function enrichComponents(page, components, { maxHtml = 4000, maxRules = 12 } = {}) {
  const selectors = [...new Set(components.map((c) => c.hostSelector).filter(Boolean))];
  if (!selectors.length) return { components, sheetsRead: 0, sheetsBlocked: 0, withoutDetail: components.length };

  await page.evaluate(`window.__deDetail = ${DETAIL_PROBE_SOURCE}`);
  const raw = await page.evaluate(
    `window.__deDetail(${JSON.stringify({ selectors, props: DETAIL_PROPS, maxHtml, maxRules })})`,
  );
  await page.evaluate('delete window.__deDetail').catch(() => {});

  const by = raw?.detail || {};
  let withoutDetail = 0;
  const enriched = components.map((c) => {
    // A component with no host element has no DOM to describe. Next.js client
    // boundaries and server-only rows are exactly this, and saying so beats
    // inventing an empty rule list that reads like "this element has no styles".
    if (!c.hostSelector || by[c.hostSelector]?.missing) { withoutDetail++; return c; }
    const d = by[c.hostSelector];
    return { ...c, markup: d.outerHTML, markupTruncated: d.truncatedHtml, classNames: d.classNames, computed: d.computed, matchedRules: d.rules };
  });

  return { components: enriched, sheetsRead: raw?.sheetsRead ?? 0, sheetsBlocked: raw?.sheetsBlocked ?? 0, withoutDetail };
}