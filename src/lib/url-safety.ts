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
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
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
  if (h.includes(':')) {
    // IPv6 literal: unique-local, link-local, mapped v4.
    return /^(fc|fd|fe8|fe9|fea|feb)/i.test(h) || h.startsWith('::ffff:');
  }
  return false;
}
