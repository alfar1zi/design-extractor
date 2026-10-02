// request-intercept.mjs - record every response the browser loads, at interception time.
//
// `context.route()` + `route.fetch()` rather than `page.on('response')`:
//   - the body is read once, when the request is intercepted, so there is no
//     Network.getResponseBody eviction race (Playwright #26388, #41512);
//   - the same route can later be fulfilled from the store, replaying the capture
//
// Redirects are followed by hand. `route.fetch({ maxRedirects: 0 })` returns the 3xx
// itself, which is the only way to see a hop before it is requested: with the default
// `maxRedirects: 5` a 302 into link-local space is fetched inside `route.fetch()`, so
// the SSRF happens before any guard can look at it.

import { assertSafeUrl } from './url-safety.mjs';
import { refInsideHostDir } from './url-tree.mjs';

const SKIP_SCHEME = /^(?:data|blob|about|chrome-extension|devtools):/i;
const MAX_HOPS = 5;

/**
 * A blocked request is fulfilled rather than aborted: aborting a main-frame
 * navigation leaves `page.goto` hanging until its own timeout, so a refused redirect
 * would cost 30s and still print nothing useful.
 *
 * `BLOCKED_HEADER` is what lets a caller tell this page apart from a real 502
 * from the site. Without it a fulfilled refusal is indistinguishable from a
 * capture, and a screenshot of "this request was blocked" gets filed as evidence
 * of what the site looks like.
 */
export const BLOCKED_HEADER = 'x-design-extractor-blocked';

export function refusal(url, reason) {
  return {
    status: 502,
    headers: { [BLOCKED_HEADER]: '1' },
    contentType: 'text/plain; charset=utf-8',
    body: `design-extractor blocked this request.\n\nURL: ${url}\nReason: ${reason}\n`,
  };
}

/** True when a `page.goto` response is one of our refusals rather than the site. */
export function isBlockedResponse(response) {
  return !!response && response.status() === 502 && response.headers()[BLOCKED_HEADER] === '1';
}

/** 301/302/303 continue as GET, matching what a browser does. */
function methodAfterRedirect(method, status) {
  return status === 307 || status === 308 ? method : 'GET';
}

/**
 * Fetch `url` following redirects one hop at a time, checking every hop's target
 * before it is requested. Returns the final response and the hops taken.
 *
 * @returns {Promise<{response: import('playwright').APIResponse, hops: Array<{from: string, to: string, status: number}>}>}
 */
export async function fetchChecked(context, route, url, { allowPrivate, method = 'GET', resolver } = {}) {
  const hops = [];
  let current = url;
  let currentMethod = method;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // Checked before the request, every time, including the first. The offending URL
    // rides on the error so a refusal names what was actually rejected, not what the
    // browser asked for.
    try {
      await assertSafeUrl(current, { allowPrivate, resolver });
    } catch (e) {
      e.blockedUrl = current;
      e.hops = [...hops];
      throw e;
    }

    // The first hop goes through `route.fetch` so the method, headers and cookies of
    // the intercepted request are preserved; later hops have no route of their own.
    const response = hop === 0
      ? await route.fetch({ url: current, maxRedirects: 0, timeout: 30_000 })
      : await context.request.fetch(current, { method: currentMethod, maxRedirects: 0, timeout: 30_000, failOnStatusCode: false });

    const location = response.headers().location;
    if (response.status() < 300 || response.status() >= 400 || !location) {
      return { response, hops };
    }

    const next = new URL(location, current).href;
    hops.push({ from: current, to: next, status: response.status() });
    currentMethod = methodAfterRedirect(currentMethod, response.status());
    await response.dispose();
    current = next;
  }

  throw new Error(`more than ${MAX_HOPS} redirects starting at ${url}`);
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {ReturnType<import('./capture-store.mjs').createCaptureStore>} store
 * @param {{allowPrivate?: boolean, onFetchError?: (e: Error) => void}} [opts]
 */
export async function installInterceptor(context, store, opts = {}) {
  const { allowPrivate = false, onFetchError, root = null } = opts;
  const seen = new Set();
  const blocked = [];
  let entryUrl = null;

  await context.route('**/*', async (route, request) => {
    const url = request.url();
    if (SKIP_SCHEME.test(url)) return route.continue();
    // Recorded before the fetch: a request that never answers is the one case
    // the store cannot discover on its own, and `missing` cannot hold it either
    // because no response was ever seen to fail.
    store.noteRequest(url);

    let response;
    let hops;
    try {
      ({ response, hops } = await fetchChecked(context, route, url, { allowPrivate, method: request.method() }));
    } catch (e) {
      const at = e.blockedUrl || url;
      blocked.push({ url: at, from: url, hops: e.hops || [], reason: e.message });
      if (onFetchError) onFetchError(e);
      return route.fulfill(refusal(at, e.message));
    }

    for (const hop of hops) store.noteRedirect(hop.from, hop.to, hop.status);

    const finalUrl = response.url();
    let body;
    try {
      body = await response.body();
    } catch (e) {
      // The bytes are gone (evicted, or a body the browser never materialised).
      // Record the loss and let the page carry on with the live response.
      store.putFailed(request, response, e);
      return route.fulfill({ response });
    }

    if (!hops.length && finalUrl && finalUrl !== url) store.noteRedirect(url, finalUrl, response.status());
    seen.add(finalUrl || url);
    store.put(request, response, body, { root });
    // The first main-frame document is the tree's entry point; a later pass opens
    // its own page and must not steal it.
    if (!entryUrl && request.isNavigationRequest()) entryUrl = finalUrl || url;
    return route.fulfill({ response });
  });

  return {
    blocked: () => blocked,
    blockedCount: () => blocked.length,
    entryUrl: () => entryUrl,
    async uninstall() {
      await context.unroute('**/*').catch(() => {});
    },
  };
}

/**
 * Resolve a captured URL to its path in the tree, relative to the document being
 * rewritten. `urlToTreePath` keeps every foreign origin inside the capture's own
 * host directory, so the result stays under that document's host directory and
 * never needs a `..` that leaves the served root. The check is here too: a
 * relative path that escapes means the two sides disagree about the convention,
 * and returning it would write a reference that resolves outside the tree.
 */
export function treeResolver(store, { docUrl } = {}) {
  const docEntry = docUrl ? store.get(docUrl) : null;
  if (!docEntry) return () => null;
  return (absUrl) => {
    const entry = store.get(absUrl);
    if (!entry) return null;
    const ref = relativeFrom(docEntry.rel, entry.rel);
    return refInsideHostDir(docEntry.rel, ref) ? ref : null;
  };
}

/** Path from the directory of one tree path to another, POSIX separators for markup. */
export function relativeFrom(docRel, toRel) {
  const parts = docRel.split('/').slice(0, -1);
  const to = toRel.split('/');
  let common = 0;
  while (common < parts.length && common < to.length - 1 && parts[common] === to[common]) common++;
  const up = parts.length - common;
  return [...Array(up).fill('..'), ...to.slice(common)].join('/');
}
