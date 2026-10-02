/**
 * URL SAFETY — one definition of "a link we must never publish or fetch",
 * shared by the importer (scripts/import) and the Baserow sync's validation.
 * Pure string checks; no network.
 */

/** Query parameters that carry a credential. A URL holding one is refused whole. */
export const CREDENTIAL_PARAM = /^(key|apikey|api[_-]?key|token|access[_-]?token|auth|secret|password|passwd|pass|sig|signature|session|sessionid|code)$/i;

/** A Vercel access grant: not a credential to publish, and never "public" without a check. */
export const ACCESS_PARAM = /^_vercel_share$/i;

/** Loopback, private, link-local, carrier-grade NAT, multicast and local names. */
export function isPrivateHost(host: string): boolean {
  // WHATWG URL keeps trailing dots, and "localhost." is still loopback.
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (h.includes(':')) return !isGlobalIpv6(h);
  return false;
}

/** Eight 16-bit groups, or null when it is not an IPv6 literal. Accepts a trailing dotted quad. */
function ipv6Groups(h: string): number[] | null {
  let text = h.split('%')[0]!; // zone id
  const quad = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (quad) {
    const [a, b, c, d] = quad.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some((n) => n > 255)) return null;
    text = `${text.slice(0, quad.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/**
 * An IPv6 address we may treat as public: ordinary global unicast
 * (2000::/3) only. Everything else — loopback, unspecified, IPv4-mapped and
 * IPv4-compatible (::/8), NAT64 (64:ff9b::/96), unique-local, link-local,
 * site-local, multicast — is refused, and so are the global ranges that wrap
 * or tunnel another address: 6to4 (2002::/16), Teredo (2001:0::/32) and the
 * documentation prefix (2001:db8::/32). An unparseable literal is refused.
 */
function isGlobalIpv6(h: string): boolean {
  const g = ipv6Groups(h);
  if (!g) return false;
  const first = g[0]!;
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2002) return false;
  if (first === 0x2001 && (g[1] === 0x0000 || g[1] === 0x0db8)) return false;
  return true;
}
