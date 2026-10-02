// theme.mjs - what actually changes between colour schemes.
//
// A theme is a media query, so light and dark are two answers to one question.
// Reading the default alone hands a rebuild half a theme without saying which
// half it got.
//
// Two things are compared, because sites express a theme in two different ways:
//
//   1. Custom properties. The shadcn pattern: --background is redefined under
//      prefers-color-scheme, and the whole palette moves with it.
//   2. Resolved style on real elements. Tailwind's pattern: no custom property
//      changes at all, the theme is plain `color` on the body. A capture that
//      only reads custom properties calls that site "no theme", which is false.
//
// The second one is a bounded sample rather than a whole-tree walk: every
// element's every property, twice, is a page-sized cost for an answer that a
// consumer uses to find the handful of places a rebuild has to handle.

/**
 * The resolved properties a theme is most likely to move. Kept short on purpose:
 * a wider set costs a second full style read per element and buries the answer.
 */
export const THEME_PROPERTIES = [
  'color', 'background-color', 'border-top-color', 'border-bottom-color',
  'outline-color', 'fill', 'stroke',
];

/** How many elements in document order to sample. */
const SAMPLE_LIMIT = 150;

/**
 * Custom properties declared on the root and body: the tokens a site named.
 *
 * Lives here rather than in tokens.mjs because the theme diff needs the same
 * reading, and importing in both directions is a cycle that only works until
 * someone adds a top-level statement to one side of it.
 */
export async function readCustomProperties(page) {
  return await page.evaluate(() => {
    const out = {};
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const style = getComputedStyle(el);
      for (const prop of style) {
        if (!prop.startsWith('--')) continue;
        const value = style.getPropertyValue(prop).trim();
        if (value && !(prop in out)) out[prop] = value;
      }
    }
    return out;
  });
}

/**
 * Read one scheme off the live page.
 *
 * Built as a string because a function passed to page.evaluate binds its
 * arguments by value, and the property list has to travel in.
 */
function sampleScript(properties, limit) {
  return `(() => {
    const props = ${JSON.stringify(properties)};
    const read = (el) => {
      const s = getComputedStyle(el);
      const out = {};
      for (const p of props) { const v = s[p]; if (v) out[p] = v; }
      return out;
    };
    const sample = [];
    const seen = [];
    for (const el of document.querySelectorAll('*')) {
      if (sample.length >= ${limit}) break;
      // A node nobody can see cannot be styled by a theme in a way anyone cares
      // about, and display:none children compute to their initial values.
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // The index is each node's own position among its same-tag siblings.
      // Using the leaf instead reads -1 as soon as the walk climbs a level, and
      // the selector comes out as nth-of-type(0), which matches nothing and
      // cannot be looked up by whoever reads this file.
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
        if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
        const tag = n.tagName.toLowerCase();
        const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
        parts.unshift(sibs.length > 1 ? tag + ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')' : tag);
      }
      const selector = parts.length ? parts.join(' > ') : 'html';
      if (seen.includes(selector)) continue;
      seen.push(selector);
      sample.push({ selector, styles: read(el) });
    }
    return sample;
  })()`;
}

/**
 * Read the page once per colour scheme, then put it back.
 *
 * The page is restored to whatever the host prefers before returning: leaving
 * it pinned would silently change every later pass that reads a media query,
 * and a capture whose later passes disagree with its own screenshot is worse
 * than one that never tried.
 *
 * @param {import('playwright').Page} page
 * @param {string[]} [colorSchemes]
 * @returns {Promise<Record<string, {properties: Record<string,string>, sample: Array}>>}
 */
export async function readColorSchemes(page, colorSchemes = ['light', 'dark']) {
  const native = await page
    .evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)
    .then((dark) => (dark ? 'dark' : 'light'))
    .catch(() => 'light');
  const script = sampleScript(THEME_PROPERTIES, SAMPLE_LIMIT);
  const schemes = {};
  try {
    for (const scheme of colorSchemes) {
      await page.emulateMedia({ colorScheme: scheme });
      const [properties, sample] = await Promise.all([
        readCustomProperties(page),
        page.evaluate(script).catch(() => []),
      ]);
      schemes[scheme] = { properties, sample };
    }
  } finally {
    await page.emulateMedia({ colorScheme: native }).catch(() => {});
  }
  return schemes;
}

/**
 * Compare the schemes against the first one captured.
 *
 * The default scheme is already in the typed token groups at the top level, so
 * only what changes is reported. A token that holds its value across both is
 * not a theme token, and listing it would make a rebuild bind a theme to a value
 * that never moves.
 *
 * @param {Record<string, {properties: object, sample: Array}>} schemes
 */
export function schemeOverrides(schemes) {
  const names = Object.keys(schemes);
  if (names.length < 2) return { differs: [], values: {}, elements: [] };
  const [base, ...others] = names;

  const differs = [];
  const values = {};
  for (const name of Object.keys(schemes[base].properties).sort()) {
    for (const other of others) {
      const to = schemes[other].properties[name];
      if (to === undefined || to === schemes[base].properties[name]) continue;
      differs.push(name);
      (values[name] ??= {})[other] = to;
    }
  }

  // The same question asked of the elements: not "which token" but "where".
  // Indexed by selector first so a site with two hundred sampled elements and
  // three changing properties does not produce six hundred rows.
  const bySelector = new Map(schemes[base].sample.map((s) => [s.selector, s.styles]));
  const elements = [];
  for (const other of others) {
    for (const entry of schemes[other].sample) {
      const from = bySelector.get(entry.selector);
      if (!from) continue;
      for (const [property, to] of Object.entries(entry.styles)) {
        if (from[property] === undefined || from[property] === to) continue;
        const existing = elements.find((e) => e.selector === entry.selector);
        if (existing) {
          existing.changed[property] = { from: from[property], [other]: to };
        } else {
          elements.push({
            selector: entry.selector,
            changed: { [property]: { from: from[property], [other]: to } },
          });
        }
      }
    }
  }

  return { differs, values, elements };
}
