// tokens.mjs - turn the cascade into a design-token set.
//
// Reads every CSS rule in the document, not just :root, because a real site's
// tokens live wherever the author put them: :root, a utility layer, a scoped
// block, a media query. A token defined once in `.theme-dark` and referenced in
// forty places is one token, not forty.
//
// Output is DTCG 2025.10: the `{value, type}` shape the format mandates, with
// aliases preserved as `{value: '{other.token}', type: 'color'}` rather than
// flattened, because the alias IS the design intent.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readColorSchemes, schemeOverrides, readCustomProperties } from './theme.mjs';

const ROLES = [
  'color', 'background-color', 'border-color', 'outline-color', 'fill', 'stroke',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'border-radius', 'border-width', 'box-shadow', 'text-shadow', 'filter', 'transition',
];

const BARE = /^[a-z][a-zA-Z0-9]*$/;
const MAX_DISTINCT_PER_PROPERTY = 64;

// An alias carries no literal value, so its type comes from the property it
// fills. `color: var(--brand-500)` is a colour even though the alias itself
// does not look like one.
const typeForProperty = (prop) => {
  if (/^(color|background-color|border-color|outline-color|fill|stroke)$/.test(prop)) return 'color';
  if (prop === 'font-family') return 'fontFamily';
  if (/^(font-size|border-radius|border-width|letter-spacing|line-height)$/.test(prop)) return 'dimension';
  if (prop === 'font-weight') return 'number';
  return 'string';
};

const toDtcgType = (prop, value) => {
  const v = value.trim();
  if (/^var\(/.test(v)) return typeForProperty(prop);
  if (/^(color|background-color|border-color|outline-color|fill|stroke)$/.test(prop)) {
    return /^(#|rgb|hsl|oklch|oklab|lab|lch|color)/.test(v) ? 'color' : 'string';
  }
  if (prop === 'font-size') return /px$|rem$|em$/.test(v) ? 'dimension' : 'fontSize';
  if (/^(border-radius|border-width|letter-spacing|line-height)$/.test(prop)) {
    return /^(calc|clamp|min|max)/.test(v) ? 'string' : 'dimension';
  }
  if (prop === 'font-weight') return /^\d+$/.test(v) ? 'number' : 'fontWeight';
  if (/^(box-shadow|text-shadow|filter|transition)$/.test(prop)) return 'string';
  if (prop === 'font-family') return 'fontFamily';
  return 'string';
};

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/\W+/g, '-').toLowerCase().replace(/^-|-$/g, '');

/**
 * Group raw declarations into tokens.
 *
 * @param {Array<{prop: string, value: string, selector: string, condition: string[]}>} decls
 */
export function buildTokens(decls) {
  const grouped = new Map();
  for (const d of decls) {
    if (!ROLES.includes(d.prop)) continue;
    const value = d.value.trim();
    // A var() reference is an alias to another token, not a token of its own.
    const alias = /^var\(\s*--([\w-]+)/.exec(value);
    const key = alias ? alias[1] : `${kebab(d.prop)}--${value}`;
    if (!grouped.has(key)) grouped.set(key, { prop: d.prop, values: new Map(), selectors: new Set(), aliased: !!alias });
    const entry = grouped.get(key);
    entry.values.set(value, (entry.values.get(value) || 0) + 1);
    entry.selectors.add(d.selector);
  }

  const tokens = [];
  for (const [key, entry] of grouped) {
    const ranked = [...entry.values].sort((a, b) => b[1] - a[1]);
    if (entry.aliased) {
      const [value, count] = ranked[0];
      tokens.push({
        $type: toDtcgType(entry.prop, value),
        $value: `{${value.replace(/^var\(\s*--/, '').replace(/\)$/, '')}}`,
        $extensions: { 'design-extractor': { property: entry.prop, uses: count, aliased: true } },
      });
      continue;
    }
    // One token per distinct value, named after the value it holds. Two sizes is
    // a scale; two hundred sizes is a page that never designed a scale.
    for (const [value, count] of ranked.slice(0, MAX_DISTINCT_PER_PROPERTY)) {
      tokens.push({
        $type: toDtcgType(entry.prop, value),
        $value: value,
        $extensions: { 'design-extractor': { property: entry.prop, uses: count, name: `${kebab(entry.prop)}-${slug(value)}` } },
      });
    }
  }
  return tokens;
}

/**
 * Type a custom property from its value, falling back to its name.
 *
 * A custom property carries no type of its own, so the value is the evidence
 * and the name is the tiebreak. `--radius: .625rem` is a dimension by both; a
 * `calc()` can hold anything at all, so only the name is left to go on.
 */
export function customTokenType(name, value, usedBy = null) {
  const v = String(value).trim();
  // An alias carries no type: `--fg: var(--card)` says nothing on its own. What
  // it fills is the evidence, so the properties that consume it decide. When
  // nothing consumes it in this capture, there is nothing to go on and guessing
  // from the name would be inventing a design decision the author never made.
  if (/^var\(\s*--/.test(v)) {
    for (const prop of usedBy || []) {
      const t = typeForProperty(prop);
      if (t !== 'string') return t;
    }
    return null;
  }
  if (/^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|color-mix\()/i.test(v)) return 'color';
  if (/^-?[\d.]+(px|rem|em|ex|ch|vh|vw|vmin|vmax)\b/i.test(v)) return 'dimension';
  if (/^-?[\d.]+(%|)$/.test(v)) return 'number';
  if (/^\d+\s*\/\s*\d+$/.test(v)) return 'number';
  if (/^(calc|clamp|min|max)\(/i.test(v)) {
    return /width|height|size|radius|spacing|gap|inset|top|left|right|bottom|padding|margin|line-height/i.test(name)
      ? 'dimension' : 'string';
  }
  if (/^(sans-serif|serif|monospace|system-ui|cursive|fantasy|ui-[a-z]+)$/i.test(v)) return 'fontFamily';
  // A comma list that is not inside a colour function is a font stack; the
  // colour functions are already matched above.
  if (v.includes(',')) return 'fontFamily';
  return 'string';
}

/**
 * Group the author's own custom properties into typed DTCG groups.
 *
 * The derived array holds values the cascade happens to use, named after the
 * value they hold. These are the tokens the author *named*, which is the set a
 * rebuild has to reproduce by name -- `--card` stays `--card` instead of
 * becoming `background-color-lab-100-0-0`. Both are kept.
 *
 * @param {Record<string, string>} customProperties
 */
export function groupCustomProperties(customProperties, usedBy = null) {
  const groups = new Map();
  let untyped = 0;
  for (const [prop, raw] of Object.entries(customProperties || {})) {
    const name = prop.replace(/^--/, '');
    const value = String(raw).trim();
    if (!name) continue;
    const alias = /^var\(\s*--([\w-]+)/.exec(value);
    const type = customTokenType(name, value, usedBy && usedBy[name]);
    if (!type) { untyped++; continue; }
    if (!groups.has(type)) groups.set(type, {});
    groups.get(type)[name] = {
      $value: alias ? `{${alias[1]}}` : value,
      ...(alias ? { $extensions: { 'design-extractor': { aliased: true } } } : {}),
    };
  }
  // Counted rather than dropped in silence: a token set that quietly omits the
  // aliases it could not type is a token set a rebuild will get wrong.
  const out = { _untyped: untyped };
  for (const [type, tokens] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    out[type] = { $type: type, ...Object.fromEntries(Object.entries(tokens).sort((a, b) => a[0].localeCompare(b[0]))) };
  }
  return out;
}

/**
 * Map each custom property to the properties that consume it.
 *
 * @param {Array<{prop: string, value: string}>} decls
 */
export function collectAliasUses(decls) {
  const uses = new Map();
  for (const d of decls || []) {
    for (const m of String(d.value).matchAll(/var\(\s*--([\w-]+)/g)) {
      if (!uses.has(m[1])) uses.set(m[1], new Set());
      uses.get(m[1]).add(d.prop);
    }
  }
  return Object.fromEntries([...uses].map(([k, v]) => [k, [...v]]));
}

function slug(value) {
  return value.replace(/\W+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 32) || 'value';
}

/** Run inside the page. Walks every stylesheet, including adopted and shadow. */
export const TOKEN_PROBE_SOURCE = `(${function probeTokens(limit) {
  const decls = [];
  const walkSheet = (sheet, condition, origin) => {
    let rules;
    try { rules = sheet.cssRules; } catch { return; } // cross-origin stylesheet
    if (!rules) return;
    for (const rule of rules) {
      // Order matters. Chrome exposes CSSStyleRule.cssRules for nested CSS as an
      // empty but PRESENT CSSRuleList, so testing cssRules first would classify
      // every ordinary style rule as a grouping rule and read nothing at all.
      if (rule.selectorText && rule.style) {
        for (const prop of ['color','background-color','border-color','border-radius','box-shadow','font-family','font-size','font-weight','line-height','letter-spacing','outline-color','fill','stroke','transition','filter']) {
          const value = rule.style.getPropertyValue(prop);
          if (value) decls.push({ prop, value, selector: rule.selectorText, condition, origin });
        }
        continue;
      }
      if (!rule.cssRules) continue;
      const cond = rule.conditionText || (rule.media && rule.media.mediaText) || null;
      walkSheet(rule, cond ? condition.concat(cond) : condition, origin);
    }
  };
  // document.styleSheets already covers <link> and inline <style> alike. Walking
  // the <style> elements again would count every inline declaration twice and
  // inflate the use counts these tokens are ranked by.
  for (const sheet of document.styleSheets) walkSheet(sheet, [], 'document');
  // Shadow trees hang their sheets off adoptedStyleSheets, which are not part of
  // document.styleSheets. Closed shadow roots stay invisible here, by design.
  for (const el of document.querySelectorAll('*')) {
    const root = el.shadowRoot;
    if (!root) continue;
    for (const sheet of root.adoptedStyleSheets || []) walkSheet(sheet, [], 'shadow');
    for (const node of root.querySelectorAll('style')) if (node.sheet) walkSheet(node.sheet, [], 'shadow');
  }
  return decls.slice(0, limit);
}})`;

/**
 * @param {import('playwright').Page} page
 * @param {{limit?: number}} [opts]
 */
export async function extractTokenDecls(page, { limit = 6000 } = {}) {
  await page.evaluate(`window.__deTokens = ${TOKEN_PROBE_SOURCE}`);
  const decls = await page.evaluate(`window.__deTokens(${limit})`);
  await page.evaluate('delete window.__deTokens').catch(() => {});
  return decls || [];
}

/**
 * The custom properties in force on the matched subtrees.
 *
 * A stylesheet walk finds every token a site declares anywhere. That is the
 * wrong answer to "what does this card use": a subtree can override a token, and
 * only the resolved value on the element itself records the override. The first
 * name seen wins so the value closest to the target is the one reported.
 */
export async function readScopedCustomProperties(page, selectors) {
  return await page.evaluate((sels) => {
    const out = {};
    const count = {};
    for (const sel of sels) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(sel)); } catch { continue; }
      for (const el of nodes) {
        const style = getComputedStyle(el);
        for (const prop of style) {
          if (!prop.startsWith('--')) continue;
          const value = style.getPropertyValue(prop).trim();
          if (!value) continue;
          if (prop in out) { count[prop]++; continue; }
          out[prop] = value;
          count[prop] = 1;
        }
      }
    }
    return { properties: out, resolvedOn: count };
  }, selectors);
}

/**
 * Write tokens.json: the properties the site named, plus the values the whole
 * cascade actually uses. The first is intent, the second is evidence, and a
 * rebuild needs both because plenty of sites name nothing at all.
 *
 * @param {import('playwright').Page} page
 * @param {string} outDir
 * @param {{scope?: string[], colorSchemes?: string[]}} [opts] `scope` holds the
 *   --target selectors; `colorSchemes` defaults to light and dark.
 */
export async function tokenPass(page, outDir, { scope = [], colorSchemes = ['light', 'dark'] } = {}) {
  const [customProperties, decls] = await Promise.all([
    readCustomProperties(page),
    extractTokenDecls(page),
  ]);
  const derived = buildTokens(decls);
  // A stylesheet walk answers "what does this site declare"; a --target run has
  // to answer "what is in force on this subtree", which is a different question
  // once a component overrides an inherited token.
  const scoped = scope.length ? await readScopedCustomProperties(page, scope) : null;
  const groups = groupCustomProperties(customProperties, collectAliasUses(decls));
  const schemes = await readColorSchemes(page, colorSchemes);
  const { differs, values, elements } = schemeOverrides(schemes);
  await writeFile(join(outDir, 'tokens.json'), JSON.stringify({
    format: 'DTCG 2025.10',
    scope: scope.length ? scope : null,
    customProperties,
    ...(scoped ? { scopedProperties: scoped.properties, resolvedOn: scoped.resolvedOn } : {}),
    derived,
    // The named tokens, typed and grouped. DTCG requires each group to declare
    // its own $type; a consumer reading `color.background` should not have to
    // infer the type from the value.
    ...Object.fromEntries(Object.entries(groups).filter(([k]) => k !== '_untyped')),
    ...(groups._untyped ? { _untypedAliases: groups._untyped } : {}),
    ...(Object.keys(schemes).length ? {
      // The default scheme is already in the typed groups above; this records
      // only what switches, so a rebuild can bind a theme without carrying a
      // second copy of every token that never changes.
      $extensions: {
        'design-extractor': {
          colorSchemes: { captured: Object.keys(schemes), differs, values, elements },
        },
      },
    } : {}),
    counts: {
      customProperties: Object.keys(customProperties).length,
      derived: derived.length,
      ...(scoped ? { scopedProperties: Object.keys(scoped.properties).length } : {}),
      colorSchemes: Object.keys(schemes).length,
      differingTokens: differs.length,
      schemeElements: elements.length,
    },
  }, null, 2));
  return {
    custom: Object.keys(customProperties).length,
    derived: derived.length,
    named: Object.values(groups).reduce((n, g) => n + Object.keys(g).length - 1, 0),
    untyped: groups._untyped,
    ...(scoped ? { scoped: Object.keys(scoped.properties).length } : {}),
  };
}