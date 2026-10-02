// components-pass.mjs - write components.authoritative.json and components.inferred.json.
//
// Two files on purpose. The authoritative file holds boundaries the framework
// itself confirmed; the inferred file holds repeated DOM shapes that merely look
// like components. A reconstruction tool that reads both from one file cannot
// tell them apart, and the second one silently turns a guess into a fact.
//
// When nothing authoritative was found the file is not written at all. An empty
// list and an absent list mean different things, and a consumer branching on
// "does this file exist" is the whole reason the split exists.

import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractComponents, clusterBySignature } from './components.mjs';
import { enrichComponents } from './component-detail.mjs';

const CLUSTER_PROBE_SOURCE = `(${function collectShapes(opts) {
  const { maxNodes = 8000, scope = [] } = opts || {};
  const scopeRoots = [];
  for (const sel of scope) {
    try { scopeRoots.push(...document.querySelectorAll(sel)); } catch { /* not a valid selector */ }
  }
  const inScope = (el) => !scope.length || (!!el && scopeRoots.some((r) => r === el || r.contains(el)));
  const nodes = [...document.querySelectorAll('body *')].slice(0, maxNodes);
  return nodes
    // A leaf with no class and no id is text, not a component shape. Clustering
    // those produces hundreds of clusters that tell a reader nothing.
    .filter((el) => inScope(el) && (el.classList.length > 0 || el.id) && el.children.length <= 2)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList],
      // innerText, not textContent: textContent concatenates with no separator,
      // so a card reading "Pro" over "Everything" became the label "ProEverything"
      // and a label is text a human reads to recognise the shape.
      text: (el.innerText || el.textContent || '').trim(),
      ariaLabel: el.getAttribute('aria-label') || '',
      html: el.outerHTML || '',
    }));
}})`;

/** Read DOM shapes for the inference pass. Best-effort: a failure is not fatal. */
export async function collectShapes(page, { maxNodes = 8000, scope = [] } = {}) {
  await page.evaluate(`window.__deShapes = ${CLUSTER_PROBE_SOURCE}`);
  const shapes = await page.evaluate(`window.__deShapes(${JSON.stringify({ maxNodes, scope })})`);
  await page.evaluate('delete window.__deShapes').catch(() => {});
  return shapes || [];
}

/**
 * @param {import('playwright').Page} page
 * @param {string} outDir
 */
/**
 * @param {object} [input.motion] the in-memory motion result, so states and
 *   motion can be attached here rather than re-read from disk
 */
export async function componentPass(page, outDir, { scope = [], motion = null } = {}) {
  const components = await extractComponents(page, { scope }).catch((e) => ({
    total: 0, error: e.message.split('\n')[0], authoritative: [], unnamed: 0,
  }));
  const shapes = await collectShapes(page, { scope }).catch(() => []);
  const clusters = clusterBySignature(shapes);

  // Every entry carries its own markup, resolved styles and matched rules, so
  // the artifact is usable without reopening a browser.
  const enriched = await enrichComponents(page, components.authoritative).catch(() => ({
    components: components.authoritative, sheetsRead: 0, sheetsBlocked: 0, withoutDetail: components.authoritative.length,
  }));

  // Behaviour, attached to the component it belongs to. A rebuild reads one
  // entry and gets the markup, the styles and what the thing does when touched;
  // making it cross-reference three files means it does not happen.
  const states = await readFile(join(outDir, 'states.json'), 'utf8')
    .then((t) => JSON.parse(t).states || []).catch(() => []);
  const bySelector = new Map();
  for (const s of states) {
    if (!s.selector) continue;
    bySelector.set(s.selector, [...(bySelector.get(s.selector) || []), s]);
  }
  const motionBySelector = new Map();
  for (const t of motion?.sampled || []) {
    if (!t.selector) continue;
    motionBySelector.set(t.selector, [...(motionBySelector.get(t.selector) || []), t]);
  }
  const withBehaviour = enriched.components.map((c) => {
    if (!c.hostSelector) return c;
    const st = bySelector.get(c.hostSelector);
    const mo = motionBySelector.get(c.hostSelector);
    if (!st && !mo) return c;
    return { ...c, states: st || undefined, motion: mo || undefined };
  });

  const named = withBehaviour.filter((c) => c.named).length;
  if (enriched.components.length) {
    await writeFile(join(outDir, 'components.authoritative.json'), JSON.stringify({
      source: 'framework-reported',
      scope: scope.length ? scope : null,
      elementsScanned: components.total,
      error: components.error,
      named,
      unnamed: enriched.components.length - named,
      // A stylesheet the browser refused to expose is a hole in this file, and
      // a component whose rules could not be read looks identical to one with no
      // rules unless the count is stated here.
      stylesheetsRead: enriched.sheetsRead,
      stylesheetsBlocked: enriched.sheetsBlocked,
      withoutMarkup: enriched.withoutDetail,
      statesAttached: withBehaviour.filter((c) => c.states).length,
      motionAttached: withBehaviour.filter((c) => c.motion).length,
      components: withBehaviour,
    }, null, 2));
  }

  await writeFile(join(outDir, 'components.inferred.json'), JSON.stringify({
    source: 'dom-clustering',
    scope: scope.length ? scope : null,
    warning: 'These are repeated DOM shapes, not confirmed component boundaries. No cluster is named, because none of them has a name.',
    shapesScanned: shapes.length,
    clusters,
  }, null, 2));

  return { named, unnamed: withBehaviour.length - named, clusters: clusters.length, wroteAuthoritative: withBehaviour.length > 0 };
}