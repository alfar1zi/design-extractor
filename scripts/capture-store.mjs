// capture-store.mjs - bounded, in-memory record of what the browser actually loaded.
// A response whose body could not be taken is recorded in `missing`, never dropped silently.

import { urlToTreePath, disambiguate, assertInsideRoot } from './url-tree.mjs';

const DEFAULTS = {
  maxBytes: 512 * 1024 * 1024,
  maxBodyBytes: 25 * 1024 * 1024,
};

export function createCaptureStore(options = {}) {
  const { maxBytes, maxBodyBytes } = { ...DEFAULTS, ...options };
  /** @type {Map<string, {url,status,headers,contentType,body,bytes,rel}>} */
  const entries = new Map();
  /** @type {Map<string, string>} tree path -> owning url, to keep paths unique */
  const claimed = new Map();
  /** URLs the browser asked for, recorded before any response is awaited. */
  const asked = new Set();
  /** URLs a response actually arrived for, whether or not its body was kept. */
  const answered = new Set();
  /** Timestamp of the last response, so a caller can wait for the network to quiet. */
  let lastActivity = Date.now();
  /** Origin of the first main-frame document. Foreign origins are namespaced under it. */
  let origin = options.origin || null;
  const missing = [];
  const redirects = [];
  let bytes = 0;

  function claim(rel, url, root) {
    if (root) assertInsideRoot(root, rel);
    // Keyed case-folded: APFS, NTFS and ext4-insensitive-by-mount treat `A.css`
    // and `a.css` as one file, so an exact-case map hands both URLs different
    // keys, the second write truncates the first, and nothing is reported. The
    // stored rel keeps its original casing; only the lookup is folded.
    const owner = claimed.get(rel.toLowerCase());
    if (owner === undefined) {
      claimed.set(rel.toLowerCase(), url);
      return rel;
    }
    if (owner === url) return rel;
    const alt = disambiguate(rel, url);
    claimed.set(alt.toLowerCase(), url);
    return alt;
  }

  function headersOf(response) {
    try { return response.headers() || {}; } catch { return {}; }
  }

  return {
    /**
     * Record a successful response. `body` may be null for statuses that carry none.
     * @param {{url():string,isNavigationRequest():boolean,resourceType():string,method():string}} request
     * @param {{url():string,status():number,headers():object}} response
     * @param {Buffer|null} body
     * @param {{root?: string}} [opts]
     */
    put(request, response, body, opts = {}) {
      answered.add(response.url());
      lastActivity = Date.now();
      const url = response.url();
      const status = response.status();
      const headers = headersOf(response);
      const previous = entries.get(url);
      if (previous) bytes -= previous.bytes;

      const contentType = headers['content-type'] || '';
      const isDocument = !!request.isNavigationRequest?.();
      // The first main-frame document defines the capture's origin. Its route
      // handler completes before any subresource is requested, so this latch is
      // set before the first foreign asset appears.
      if (isDocument && !origin) origin = new URL(url).origin;
      const { rel } = urlToTreePath(url, { contentType, isDocument, origin });

      if (body && body.length > maxBodyBytes) {
        entries.delete(url);
        missing.push({ url, reason: 'body-too-large', bytes: body.length, detail: `over per-body cap ${maxBodyBytes}` });
        return null;
      }
      if (bytes + (body ? body.length : 0) > maxBytes) {
        entries.delete(url);
        missing.push({ url, reason: 'store-full', detail: `over total cap ${maxBytes}` });
        return null;
      }

      const entry = {
        url,
        status,
        resourceType: request.resourceType?.() || 'other',
        headers,
        contentType,
        contentLength: Number(headers['content-length'] || 0),
        body: body ?? null,
        bytes: body ? body.length : 0,
        rel: claim(rel, url, opts.root),
      };
      entries.set(url, entry);
      bytes += entry.bytes;
      return entry;
    },

    /** Record a response we saw but could not read a body from. */
    putFailed(request, response, error) {
      const url = response.url();
      answered.add(url);
      lastActivity = Date.now();
      entries.delete(url);
      missing.push({ url, reason: 'body-unavailable', detail: String(error?.message || error) });
      return null;
    },

    noteRedirect(from, to, status) {
      redirects.push({ from, to, status });
    },

    get(url) {
      return entries.get(url) || null;
    },

    /**
     * Drop every retained body, keeping the metadata.
     *
     * Call once the tree is on disk. The bodies are the largest thing the process
     * holds, they are dead the moment `writeTree` returns, and the passes that run
     * afterwards would otherwise add a second capture's worth on top.
     *
     * @returns {number} bytes released
     */
    releaseBodies() {
      let released = 0;
      for (const e of entries.values()) {
        if (e.body) { released += e.bytes; e.body = null; }
      }
      return released;
    },

    get missing() { return missing; },
    get redirects() { return redirects; },
    /**
     * Record a request the browser has issued.
     *
     * Called before the response is awaited, not after it lands: a request that
     * never comes back is exactly the case a capture cannot otherwise see, and
     * recording it afterwards would only ever add URLs that already answered.
     */
    noteRequest(url) { asked.add(url); },

    /** True when no response has landed for `ms` - the network has gone quiet. */
    quietFor(ms) { return Date.now() - lastActivity >= ms; },

    /** Serializable manifest view: metadata only, never the bodies. */
    captureStats() {
      const list = [...entries.values()]
        .map((e) => ({
          url: e.url, rel: e.rel, status: e.status, method: e.method,
          resourceType: e.resourceType, contentType: e.contentType,
          contentLength: e.contentLength, bytes: e.bytes,
        }))
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      return {
        entries: list,
        bytes,
        caps: { maxBytes, maxBodyBytes },
        missing: [...missing],
        // Requests the browser made that no response ever arrived for. A page can
        // be torn down mid-flight, or a capture can stop with work still queued:
        // `missing` reads empty in both cases and a consumer would conclude the
        // clone is complete while it is silently missing whole chunks.
        uncaptured: [...asked].filter((u) => !answered.has(u)).map((url) => ({ url, reason: 'no-response' })),
        redirects: [...redirects],
      };
    },
  };
}