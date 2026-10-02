// next-rsc.mjs - read the Next.js App Router's server-rendered payload.
//
// Why this is its own module: it reads a string off `self.__next_f`, not the
// DOM. The server already decided the component tree and shipped it as a
// React Server Component payload, which is the most authoritative source on the
// page — it is the server's own answer, before any client bundle re-rendered it.
// Nothing here touches a live element, and nothing in the DOM probe needs it.
//
// The ceiling, stated once so nobody has to rediscover it: a "$L<hex>" row is a
// client-component boundary that resolves to a webpack id. No runtime technique
// recovers a source path from a production build — only source maps do. So a
// boundary is reported as a boundary and never dressed up as a filename.

/** Run inside the page. Reads `self.__next_f` and nothing else. */
export const RSC_PROBE_SOURCE = `(${function probeRsc(opts) {
  const { maxRows = 6000 } = opts || {};
  if (!Array.isArray(self.__next_f)) return { present: false, chunks: 0, found: [] };

  const found = [];
  let budget = maxRows;
  let chunks = 0;

  for (const entry of self.__next_f) {
    const text = entry && entry[1];
    if (typeof text !== 'string' || budget <= 0) continue;
    chunks++;
    // Each chunk is "<row-id>:<payload>"; the id is transport bookkeeping and
    // the payload after the first colon is the JSON for that row.
    const cut = text.indexOf(':');
    const body = cut > 0 ? text.slice(cut + 1) : text;
    if (!body) continue;
    let parsed;
    try { parsed = JSON.parse(body); } catch { continue; }

    const walk = (node, depth) => {
      if (budget-- <= 0 || depth > 40) return;
      if (Array.isArray(node)) {
        if (node[0] === '$' && typeof node[1] === 'string') {
          const type = node[1];
          // "$L<hex>" is a reference to a lazily-loaded client module. It is a
          // boundary, not an element, so it gets no domNode and no componentName.
          const boundary = /^L[0-9a-f]+$/i.test(type);
          found.push({
            framework: 'next',
            domNode: boundary ? null : type,
            hasDomNode: !boundary,
            componentName: null,
            rawComponentName: boundary ? type : null,
            propKeys: Object.keys(node[3] || {}),
            key: node[2] === null || node[2] === undefined ? null : String(node[2]),
            depth,
            from: 'rsc-payload',
            clientBoundary: boundary,
          });
        }
        for (const child of node) walk(child, depth + 1);
      } else if (node && typeof node === 'object') {
        for (const child of Object.values(node)) walk(child, depth + 1);
      }
    };
    walk(parsed, 0);
  }
  return { present: true, chunks, found };
}})`;

/**
 * Read the App Router payload from a loaded page.
 *
 * Not scoped. The payload is what the server sent, so it predates the DOM and
 * carries no element to test a --target selector against; filtering it would
 * mean guessing which subtree a serialized row rendered into.
 *
 * @param {import('playwright').Page} page
 * @param {{maxRows?: number}} [opts]
 */
export async function readRscPayload(page, { maxRows = 6000 } = {}) {
  await page.evaluate(`window.__deRsc = ${RSC_PROBE_SOURCE}`);
  const raw = await page.evaluate(`window.__deRsc(${JSON.stringify({ maxRows })})`);
  await page.evaluate('delete window.__deRsc').catch(() => {});
  return raw || { present: false, chunks: 0, found: [] };
}