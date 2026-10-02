// url-tree.mjs - map an absolute URL to a collision-free, escape-proof path under a capture root.
// The layout is host / path, so two origins serving the same filename never overwrite each other.

import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';

// content-type -> extension. First matching prefix wins.
const BY_CONTENT_TYPE = [
  ['text/html', '.html'],
  ['text/css', '.css'],
  ['application/javascript', '.js'],
  ['text/javascript', '.js'],
  ['application/json', '.json'],
  ['application/ld+json', '.json'],
  ['application/manifest+json', '.json'],
  ['image/svg+xml', '.svg'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/x-icon', '.ico'],
  ['image/vnd.microsoft.icon', '.ico'],
  ['image/bmp', '.bmp'],
  ['text/xml', '.xml'],
  ['application/xml', '.xml'],
  ['font/woff2', '.woff2'],
  ['font/woff', '.woff'],
  ['font/ttf', '.ttf'],
  ['font/otf', '.otf'],
  ['application/vnd.ms-fontobject', '.eot'],
  ['application/wasm', '.wasm'],
  ['video/mp4', '.mp4'],
  ['audio/mpeg', '.mp3'],
];

// RFC 3986 unreserved set is ALPHA / DIGIT / "-" / "." / "_" / "~". Escaping `~` is
// not merely redundant: Turbopack pairs a bundle chunk by comparing the literal `src`
// attribute against build-time filenames, so a stored `%7E` matches nothing and the
// app never hydrates. Unreserved characters have to survive byte-for-byte.
const UNSAFE = /[^A-Za-z0-9._~-]/g;
const PLAIN_EXT = /^\.[a-z0-9]{1,8}$/;

export function digest(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

export function escapeSegment(segment) {
  // A segment that is exactly "." or ".." would change the meaning of the path.
  if (segment === '.' || segment === '..') return '%2E'.repeat(segment.length);
  const escaped = segment.replace(UNSAFE, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());
  if (escaped.startsWith('.')) return '%2E' + escaped.slice(1);
  // Reserved Windows device names are not portable.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(escaped)) return `_${escaped}`;
  return escaped || '%20';
}

export function extensionFor(url, { contentType } = {}) {
  if (contentType) {
    const mime = String(contentType).split(';')[0].trim().toLowerCase();
    // Only a type with a real subtype is trustworthy; "text" alone is not.
    if (mime.includes('/')) {
      const hit = BY_CONTENT_TYPE.find(([prefix]) => mime === prefix || mime.startsWith(prefix + '+'));
      if (hit) return hit[1];
    }
  }
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return '.bin'; }
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot > 0) {
    const ext = last.slice(dot).toLowerCase();
    if (PLAIN_EXT.test(ext)) return ext;
  }
  return '.bin';
}

function splitName(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return { base: filename, ext: '' };
  return { base: filename.slice(0, dot), ext: filename.slice(dot) };
}

const joinRel = (segments) => segments.filter(Boolean).join('/');

// Every foreign origin is namespaced under this directory, beneath the capture's own host.
export const EXTERNAL_DIR = '__external__';

const hostOf = (u) => (u.port ? `${u.hostname}_${u.port}` : u.hostname);

/**
 * Directories a URL's own segments sit under. Everything the capture started
 * from is host-rooted; a URL from another origin is namespaced under the
 * capture's own host directory as `__external__/<host>/`.
 *
 * Host-rooting the foreign asset instead is what wrote
 * `../cdn.test/i.png` into a document at `x.test/index.html`: the only relative
 * path between the two climbs out of the host directory, which is the document
 * root once the tree is served the way `rewriteHtml` assumes. The namespace can
 * collide with a real `__external__/` path of the captured site; `disambiguate`
 * settles that, costing one URL a digest suffix rather than correctness.
 */
function rootSegments(u, origin) {
  const host = hostOf(u);
  if (!origin) return [host];
  let site;
  try { site = new URL(origin); } catch { return [host]; }
  return site.origin === u.origin ? [host] : [hostOf(site), EXTERNAL_DIR, host];
}

/**
 * A tree path is one relative path under the root: never absolute, never `..`.
 * Throws rather than returning, so a path that would leave the root stops the
 * write instead of reaching the document.
 */
export function assertSafeRel(rel) {
  const bad = typeof rel !== 'string' || !rel || rel.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(rel);
  if (bad) throw new Error(`url-tree: path escapes capture root: ${rel}`);
  return rel;
}

/**
 * Whether a reference written into the document at `docRel` still resolves
 * inside that document's host directory, which is what the tree is served as
 * the root of. A `..` that climbs no further is fine; one that climbs past the
 * host segment points outside the served tree, which is the escape this guards.
 */
export function refInsideHostDir(docRel, ref) {
  const up = ref.split('/').filter((s) => s === '..').length;
  return up <= docRel.split('/').length - 2;
}

/**
 * @param {string} url absolute URL
 * @param {{contentType?: string, isDocument?: boolean, origin?: string|null}} [opts]
 *   `origin` is the origin the capture started from; a URL from any other origin
 *   is namespaced under it rather than under its own host.
 * @returns {{rel: string, ext: string, isIndex: boolean}}
 */
export function urlToTreePath(url, opts = {}) {
  const { contentType, isDocument = false, origin = null } = opts;
  const u = new URL(url);
  const ext = extensionFor(url, { contentType });
  // A query string selects a different resource, so it must select a different file.
  // It never becomes a directory level: fold a digest of it into the name instead.
  const variant = u.search ? `-${digest(u.search)}` : '';
  // Hostnames go through the same escaping as path segments. A host of `con`,
  // `nul` or `aux` is not reachable as a directory on Windows, and the device-name
  // guard inside escapeSegment is the only thing that renames it.
  const prefix = rootSegments(u, origin).map(escapeSegment);

  const rawSegments = u.pathname.split('/').filter(Boolean);
  const segments = rawSegments.map(escapeSegment);
  const lastRaw = rawSegments[rawSegments.length - 1];
  const hasFilename = Boolean(lastRaw && PLAIN_EXT.test(`.${lastRaw.slice(lastRaw.lastIndexOf('.') + 1).toLowerCase()}`) && lastRaw.includes('.'));

  // A path with a real extension is a file; anything else is a document to be named index.html.
  if (hasFilename && !isDocument) {
    const { base, ext: nameExt } = splitName(segments[segments.length - 1]);
    return {
      rel: assertSafeRel(joinRel([...prefix, ...segments.slice(0, -1), `${base}${variant}${nameExt}`])),
      ext,
      isIndex: false,
    };
  }
  return { rel: assertSafeRel(joinRel([...prefix, ...segments, 'index.html'])), ext: '.html', isIndex: true };
}

/** Disambiguate a path already claimed by a different URL; the file stays openable. */
export function disambiguate(rel, url) {
  const slash = rel.lastIndexOf('/');
  const dir = slash === -1 ? '' : rel.slice(0, slash + 1);
  const base = slash === -1 ? rel : rel.slice(slash + 1);
  const { base: stem, ext } = splitName(base);
  return `${dir}${stem}-${digest(url)}${ext}`;
}

/** Guard: the resolved path must stay under `root`. Throws otherwise. */
export function assertInsideRoot(root, rel) {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  // `resolve('/')` has no trailing separator, so the prefix test would be
  // '//' and every child would be rejected with a misleading "escapes root".
  if (abs !== rootAbs && !abs.startsWith(rootAbs === sep ? sep : rootAbs + sep)) {
    throw new Error(`url-tree: path escapes capture root: ${rel}`);
  }
  return abs;
}
