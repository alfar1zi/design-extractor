// rewrite.mjs - turn a captured byte tree into a page that renders with no network.
// Every rewrite is additive: an unresolvable URL is left exactly as it was and reported.
// All three rewriters return a plain string; pass `collect` to receive the skipped list.

/** URL schemes that never hit the network and must survive verbatim. */
const INERT = /^(?:data:|blob:|javascript:|mailto:|tel:|about:|chrome-extension:|#)/i;

/**
 * Resolve a possibly-relative URL against the document it was found in.
 * @returns {string|null} absolute URL, or null when the reference is inert.
 */
export function resolveAgainst(baseUrl, ref) {
  const raw = String(ref || '').trim();
  if (!raw || INERT.test(raw)) return null;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Whether `abs` is served from the same origin as the document being rewritten.
 * A missing baseUrl means nothing is known to be same-origin.
 */
function sameOrigin(abs, baseUrl) {
  if (!baseUrl) return false;
  try {
    return new URL(abs).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Whether a reference is written as a path relative to the document, which is
 * the only form that can be left exactly as authored.
 *
 * An absolute URL on the same origin - `https://site/img.png` inside
 * `https://site/` - looks harmless and is not. Replaying the tree from a local
 * server makes it a request to the real site, so an "offline" copy quietly
 * loaded 38 of its images from the network, and got none of them when the
 * network was closed. Only a relative reference resolves against the tree's own
 * base href, so only a relative reference is left alone.
 */
function isRelativeRef(value) {
  const v = String(value).trim();
  if (!v) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return false;   // scheme: http:, data:, blob:
  if (v.startsWith('//')) return false;               // protocol-relative
  return true;
}

function mapSrcset(value, baseUrl, resolver, missed) {
  return value.split(',').map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return trimmed;
    const sp = trimmed.search(/\s/);
    const urlPart = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const descriptor = sp === -1 ? '' : trimmed.slice(sp);
    const abs = resolveAgainst(baseUrl, urlPart);
    if (isRelativeRef(urlPart) && sameOrigin(abs, baseUrl)) return trimmed;
    if (!abs) return trimmed;
    const mapped = resolver ? resolver(abs) : null;
    if (!mapped) { missed.push({ url: abs }); return trimmed; }
    return `${mapped}${descriptor}`;
  }).join(', ');
}

function injectBase(html) {
  const base = '<base href="./">';
  if (/<base\s/i.test(html)) return html.replace(/<base\s[^>]*>/i, base);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${base}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${base}</head>`);
  return base + html;
}
const URL_ATTR = '(?:src|href|data)';
const SRCSET_ATTR = '(?:srcset|poster)';
const TAG = '(?:script|link|img|source|video|audio|embed|track|iframe|object|input|use|image)';

// Anything that is not a `>` outside a quoted run. `[^>]*` looks equivalent and is
// not: an attribute value may legally contain `>`, so `data-x="a>b"` ended the tag
// early and every attribute after it stopped being rewritten. The quoted branches
// are what let the scan cross that `>`.
const TAG_BODY = '(?:"[^"]*"|\'[^\']*\'|[^>])*?';

// Group 1 is everything up to and including `name=`, group 2 names the attribute,
// group 3 is the quote and group 4 the raw value. Both attribute alternatives must
// consume their own `=`, so the separator lives inside the group.
const ATTR_RE = new RegExp(
  `(<${TAG}\\b${TAG_BODY}\\b(${URL_ATTR}|${SRCSET_ATTR})\\s*=\\s*)(["'])([^"']*)\\3`,
  'gi',
);
const SRCSET_ONLY_RE = new RegExp(`^${SRCSET_ATTR}$`, 'i');

/** Index of the `>` that closes the open tag starting at `from`, or -1 if none does. */
function openTagEnd(text, from) {
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

const BLOCK_OPEN_RE = /<(script|style)\b/gi;

/**
 * Replace each rewritable script/style *body* with a token the attribute pass
 * cannot match, leaving the opening tag in the document so its own src/href is
 * still rewritten.
 *
 * A single regex cannot do this. `<(script|style)\b([^>]*)>` ends the tag at the
 * first `>`, which is inside a quoted attribute the moment a page writes
 * `data-x="a>b"`: the tag was truncated to `<script data-x="a`, its own `src` fell
 * into the parked body, and the document came out missing both. The scanner looks
 * for the `>` the browser would find, and for the matching close tag.
 */
function parkBodies(html, { baseUrl, resolver, missed }) {
  const bodies = [];
  let out = '';
  let cursor = 0;
  BLOCK_OPEN_RE.lastIndex = 0;
  let open;
  while ((open = BLOCK_OPEN_RE.exec(html)) !== null) {
    const start = open.index;
    const tag = open[1].toLowerCase();
    const end = openTagEnd(html, start);
    if (end === -1) break;
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    closeRe.lastIndex = end + 1;
    const close = closeRe.exec(html);
    if (!close) { BLOCK_OPEN_RE.lastIndex = end + 1; continue; }

    const openTag = html.slice(start, end + 1);
    out += html.slice(cursor, start);
    if (/type\s*=\s*["'][^"']*json/i.test(openTag)) {
      // JSON blocks are data, not code: they must survive verbatim.
      out += html.slice(start, close.index + close[0].length);
    } else {
      const inner = html.slice(end + 1, close.index);
      const sub = tag === 'style'
        ? rewriteCss(inner, { baseUrl, resolver })
        : rewriteJs(inner, { baseUrl, resolver });
      missed.push(...sub.missed);
      bodies.push(sub.text);
      out += `${openTag}\u0000${bodies.length - 1}\u0000</${tag}>`;
    }
    cursor = close.index + close[0].length;
    BLOCK_OPEN_RE.lastIndex = cursor;
  }
  out += html.slice(cursor);
  return { parked: out, bodies };
}

export function rewriteHtml(html, { baseUrl, resolver, collect } = {}) {
  const missed = [];
  const { parked, bodies } = parkBodies(String(html), { baseUrl, resolver, missed });

  const rewritten = parked.replace(ATTR_RE, (whole, prefix, attrName, quote, value) => {
    if (SRCSET_ONLY_RE.test(attrName)) {
      return `${prefix}${quote}${mapSrcset(value, baseUrl, resolver, missed)}${quote}`;
    }
    const abs = resolveAgainst(baseUrl, value);
    if (!abs) return whole;
    // A RELATIVE same-origin reference stays byte-identical. The markup is also a
    // program input: bundle runtimes pair chunks by comparing the literal
    // attribute against build-time strings. Turbopack does exactly that - it
    // matches `getAttribute('src')` against its '/_next/' prefix plus a hardcoded
    // chunk list - so rewriting to another relative path leaves every chunk
    // unregistered, `hydrateRoot` never fires and the captured page silently never
    // becomes interactive. A relative path is also already correct under the
    // tree's base href.
    //
    // An ABSOLUTE same-origin URL is a different thing and is not left alone. It
    // is a request to the real site, not to the tree: an offline replay of a
    // captured page loaded 0 of its 38 images and issued 18 live requests.
    if (isRelativeRef(value) && sameOrigin(abs, baseUrl)) return whole;
    const mapped = resolver ? resolver(abs) : null;
    if (!mapped) { missed.push({ url: abs }); return whole; }
    return `${prefix}${quote}${mapped}${quote}`;
  });

  if (typeof collect === 'function') collect(missed);
  return injectBase(rewritten).replace(/\u0000(\d+)\u0000/g, (_, i) => bodies[Number(i)]);
}

// ---- CSS ----

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s][^)]*?))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?!url\()\s*(?:"([^"]*)"|'([^']*)')/gi;

export function rewriteCss(css, { baseUrl, resolver, collect } = {}) {
  const missed = [];
  const map = (value) => {
    const abs = resolveAgainst(baseUrl, value);
    if (!abs) return null;
    const mapped = resolver ? resolver(abs) : null;
    if (!mapped) missed.push({ url: abs });
    return mapped;
  };

  let result = String(css);
  result = result.replace(CSS_URL_RE, (whole, dq, sq, bare) => {
    const mapped = map((dq ?? sq ?? bare ?? '').trim());
    return mapped ? `url("${mapped}")` : whole;
  });
  result = result.replace(CSS_IMPORT_RE, (whole, dq, sq) => {
    const mapped = map((dq ?? sq ?? '').trim());
    return mapped ? `@import "${mapped}"` : whole;
  });

  if (typeof collect === 'function') collect(missed);
  return { text: result, missed };
}

// ---- JS ----

// Only literal string arguments in these positions are candidates; a dynamic
// concatenation like `"/static/" + e` is left alone because it cannot be resolved.
const JS_LITERAL_CALL_RE = /(\b(?:fetch|importScripts|import|require|new\s+Worker|new\s+SharedWorker)\s*\(\s*)(["'])([^"'\n]+)\2/g;
const JS_ASSIGN_URL_RE = /(\b(?:__webpack_require__\.p|__webpack_public_path__|import\.meta\.url)\s*=\s*)(["'])([^"'\n]+)\2/g;

export function rewriteJs(js, { baseUrl, resolver, collect } = {}) {
  const missed = [];
  const replaceLiteral = (whole, prefix, quote, value) => {
    const abs = resolveAgainst(baseUrl, value);
    if (!abs) return whole;
    const mapped = resolver ? resolver(abs) : null;
    if (!mapped) { missed.push({ url: abs }); return whole; }
    return `${prefix}${quote}${mapped}${quote}`;
  };

  let result = String(js);
  result = result.replace(JS_LITERAL_CALL_RE, replaceLiteral);
  result = result.replace(JS_ASSIGN_URL_RE, replaceLiteral);

  if (typeof collect === 'function') collect(missed);
  return { text: result, missed };
}