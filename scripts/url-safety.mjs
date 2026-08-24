// url-safety.mjs - SSRF guard for user-supplied URLs.
// Blocks private/loopback/link-local targets unless opts.allowPrivate is set.

import dns from 'node:dns/promises';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function isPrivateAddress(addr) {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  // IPv6 loopback and link-local
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Strip IPv6 zone id
  const bare = lower.split('%')[0];
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) — extract trailing IPv4
  const mapped = bare.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  // IPv4 dotted-quad
  const m = bare.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [, a, b] = m;
  const o1 = Number(a), o2 = Number(b);
  if (o1 === 10) return true;                          // 10.0.0.0/8
  if (o1 === 127) return true;                         // 127.0.0.0/8 loopback
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
  if (o1 === 192 && o2 === 168) return true;           // 192.168.0.0/16
  if (o1 === 169 && o2 === 254) return true;           // 169.254.0.0/16 link-local
  if (o1 === 0) return true;                           // 0.0.0.0/8
  return false;
}

function hostnameIsLocalLiteral(hostname) {
  if (!hostname) return false;
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost') return true;
  // Literal IPv4 in hostname
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) return isPrivateAddress(lower);
  // Literal IPv6 in hostname (brackets already stripped)
  if (lower.includes(':')) return isPrivateAddress(lower);
  return false;
}

export async function assertSafeUrl(rawUrl, opts = {}) {
  const { allowPrivate = false, resolver = dns.lookup } = opts;
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { throw new Error(`invalid URL: ${rawUrl}`); }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`disallowed URL scheme: ${parsed.protocol} (only http: and https: allowed)`);
  }
  const hostname = parsed.hostname;
  if (!hostname) throw new Error(`URL has no hostname: ${rawUrl}`);

  if (allowPrivate) return true;

  if (hostnameIsLocalLiteral(hostname)) {
    throw new Error(`URL resolves to a private/loopback address: ${hostname}`);
  }

  // Resolve and check every returned address
  let addresses;
  try {
    const result = await resolver(hostname, { all: true });
    addresses = Array.isArray(result) ? result : [{ address: result?.address }];
  } catch (e) {
    throw new Error(`DNS lookup failed for ${hostname}: ${e.message}`);
  }
  if (!addresses || addresses.length === 0) throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`URL resolves to a private/loopback address: ${hostname} -> ${address}`);
    }
  }
  return true;
}
