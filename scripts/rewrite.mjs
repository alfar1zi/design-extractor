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
 * Same-origin references are left exactly as authored (see the note in
 * `rewriteHtml`); anything else must be repointed into the tree or it hits the
 * network. A missing baseUrl means nothing is known to be same-origin.
 */
function sameOrigin(abs, baseUrl) {
  if (!baseUrl) return false;
  try {
    return new URL(abs).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function mapSrcset(value, baseUrl, resolver, missed) {
  return value.split(',').map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return trimmed;
    const sp = trimmed.search(/\s/);
    const urlPart = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const descriptor = sp === -1 ? '' : trimmed.slice(sp);
    const abs = resolveAgainst(baseUrl, urlPart);
    if (sameOrigin(abs, baseUrl)) return trimmed;
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

// Group 1 is everything up to and including `name=`, group 2 names the attribute,
// group 3 is the quote and group 4 the raw value. Both attribute alternatives must
// consume their own `=`, so the separator lives inside the group.
const ATTR_RE = new RegExp(
  `(<${TAG}\\b[^>]*?\\b(${URL_ATTR}|${SRCSET_ATTR})\\s*=\\s*)(["'])([^"']*)\\3`,
  'gi',
);
const SRCSET_ONLY_RE = new RegExp(`^${SRCSET_ATTR}$`, 'i');

export function rewriteHtml(html, { baseUrl, resolver, collect } = {}) {
  const missed = [];
  const BLOCK_RE = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

  // A script or style body is a foreign language: markup inside a JS string must not
  // be read as an attribute. Park each rewritten *body* behind a token the attribute
  // pass cannot match, leaving the opening tag in the document so its own src/href is
  // still rewritten.
  const bodies = [];
  const parked = String(html).replace(BLOCK_RE, (whole, tag, attrs, inner, offset, source) => {
    // JSON blocks are data, not code: they must survive verbatim.
    if (/type\s*=\s*["'][^"']*json/i.test(attrs)) return whole;
    const sub = tag.toLowerCase() === 'style'
      ? rewriteCss(inner, { baseUrl, resolver })
      : rewriteJs(inner, { baseUrl, resolver });
    missed.push(...sub.missed);
    bodies.push(sub.text);
    const openTag = source.slice(offset, offset + whole.indexOf('>') + 1);
    return `${openTag}\u0000${bodies.length - 1}\u0000</${tag}>`;
  });

  const rewritten = parked.replace(ATTR_RE, (whole, prefix, attrName, quote, value) => {
    if (SRCSET_ONLY_RE.test(attrName)) {
      return `${prefix}${quote}${mapSrcset(value, baseUrl, resolver, missed)}${quote}`;
    }
    const abs = resolveAgainst(baseUrl, value);
    if (!abs) return whole;
    // Same-origin references stay byte-identical. A document-relative path loads the
    // same bytes, but the markup is also a program input: bundle runtimes pair
    // chunks by comparing the literal attribute against build-time strings.
    // Turbopack does exactly that — it matches `getAttribute('src')` against its
    // '/_next/' prefix plus a hardcoded chunk list — so rewriting to a relative path
    // leaves every chunk unregistered, `hydrateRoot` never fires and the captured
    // page silently never becomes interactive. Authored paths are also correct
    // as-is once the tree's host directory is served as the document root.
    if (sameOrigin(abs, baseUrl)) return whole;
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