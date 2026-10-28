// url-safety.mjs - SSRF guard for user-supplied URLs.
// Blocks private/loopback/link-local/reserved targets unless opts.allowPrivate is set.

import dns from 'node:dns/promises';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// IPv4 ranges a capture must never reach. Reserved blocks are refused as well as
// private ones: a capture tool has no legitimate reason to touch TEST-NET or
// multicast space, and leaving them open means an address that is only sometimes
// routable decides whether the guard holds.
const v4 = (a, b, c, d) => (((a << 24) >>> 0) + (b << 16) + (c << 8) + d);

const V4_BLOCKS = [
  [v4(0, 0, 0, 0), 8],          // 0.0.0.0/8       this host
  [v4(10, 0, 0, 0), 8],         // 10.0.0.0/8      private
  [v4(100, 64, 0, 0), 10],       // 100.64.0.0/10   carrier-grade NAT
  [v4(127, 0, 0, 0), 8],         // 127.0.0.0/8     loopback
  [v4(169, 254, 0, 0), 16],       // 169.254.0.0/16  link-local, cloud metadata
  [v4(172, 16, 0, 0), 12],       // 172.16.0.0/12   private
  [v4(192, 0, 0, 0), 24],         // 192.0.0.0/24    IETF protocol assignments
  [v4(192, 0, 2, 0), 24],         // 192.0.2.0/24    TEST-NET-1
  [v4(192, 168, 0, 0), 16],       // 192.168.0.0/16  private
  [v4(198, 18, 0, 0), 15],        // 198.18.0.0/15   benchmarking
  [v4(198, 51, 100, 0), 24],      // 198.51.100.0/24 TEST-NET-2
  [v4(203, 0, 113, 0), 24],       // 203.0.113.0/24  TEST-NET-3
  [v4(224, 0, 0, 0), 4],           // 224.0.0.0/4     multicast
  [v4(240, 0, 0, 0), 4],           // 240.0.0.0/4     reserved, includes 255.255.255.255
];

/**
 * Whether a dotted quad sits in any blocked IPv4 range.
 * @param {string} text dotted-quad literal
 */
function isPrivateIPv4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (bytes.some((b) => Number.isNaN(b) || b > 255)) return false;
  const value = v4(bytes[0], bytes[1], bytes[2], bytes[3]);
  for (const [base, prefix] of V4_BLOCKS) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === (base & mask) >>> 0) return true;
  }
  return false;
}

/** `::ffff:7f00:1` and `::ffff:127.0.0.1` both mean 127.0.0.1. */
function hexToIPv4(hi, lo) {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** Expand an IPv6 literal into eight 16-bit groups, or null when unparseable. */
function parseIPv6(input) {
  const text = String(input).toLowerCase().split('%')[0];
  if (!text.includes(':')) return null;
  const mid = text.indexOf('::');
  const headPart = mid === -1 ? text : text.slice(0, mid);
  const tailPart = mid === -1 ? '' : text.slice(mid + 2);

  const toGroups = (part) => {
    if (part === '') return [];
    const segs = part.split(':');
    // An IPv4 tail (`::ffff:1.2.3.4`) occupies the last two groups.
    const last = segs[segs.length - 1];
    if (last.includes('.')) {
      const quad = last.split('.').map(Number);
      if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
      segs.splice(segs.length - 1, 1, (((quad[0] << 8) | quad[1]) >>> 0).toString(16), (((quad[2] << 8) | quad[3]) >>> 0).toString(16));
    }
    const out = [];
    for (const s of segs) {
      if (!/^[0-9a-f]{1,4}$/.test(s)) return null;
      out.push(parseInt(s, 16));
    }
    return out;
  };

  const head = toGroups(headPart);
  const tail = toGroups(tailPart);
  if (!head || !tail) return null;
  if (mid === -1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/** Whether an IPv6 literal is loopback, link-local, unique-local, mapped or reserved. */
function isPrivateIPv6(groups) {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((g) => g === 0)) return true;                          // ::  unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true;  // ::1 loopback
  if ((g0 & 0xffc0) === 0xfe80) return true;                              // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true;                              // fc00::/7 unique-local
  if ((g0 & 0xff00) === 0xff00) return true;                              // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true;                        // 2001:db8::/32 documentation
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) both carry a v4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIPv4(hexToIPv4(g6, g7));
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(hexToIPv4(g6, g7));
  }
  // 64:ff9b::/96 NAT64 maps the embedded v4 address into a private network.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIPv4(hexToIPv4(g6, g7));
  }
  return false;
}

/**
 * Whether an address string names a private, loopback, link-local or reserved
 * target. Accepts dotted-quad IPv4, IPv6 with or without brackets, a zone id,
 * an IPv4-mapped or NAT64-wrapped IPv6 form.
 */
export function isPrivateAddress(addr) {
  if (!addr) return false;
  const bare = String(addr).toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!bare) return false;
  if (bare.includes(':')) {
    const groups = parseIPv6(bare);
    return groups ? isPrivateIPv6(groups) : false;
  }
  return isPrivateIPv4(bare);
}

function hostnameIsLocalLiteral(hostname) {
  if (!hostname) return false;
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost') return true;
  if (lower.endsWith('.localhost') || lower === 'localhost.') return true;
  if (lower.includes(':')) return isPrivateAddress(lower);
  if (/^[0-9.]+$/.test(lower)) return isPrivateAddress(lower);
  return false;
}

// Defense-in-depth, not a hard guarantee. Validation happens at check time;
// the actual Playwright goto happens later, so DNS rebinding is theoretically
// possible against an attacker who controls the DNS path between the two calls.
// Closes the common case (literal private/loopback targets in URLs, including
// the IPv4-mapped and NAT64 IPv6 forms) but is not a TOCTOU-proof SSRF shield.
// Pair with network policy / egress firewall for high-trust environments.
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

  // Resolve and check every returned address. A host whose AAAA record is an
  // IPv4-mapped literal is the same hole as the literal form: the check has to
  // run on the resolved address, not only on what the URL spelled.
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
