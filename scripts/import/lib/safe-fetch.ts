/**
 * A FETCH THAT CANNOT BE AIMED INWARD — for import-time checks only.
 *
 * Used by the link check and the favicon enrichment, never by a page render.
 * Every hop is validated before a byte is sent:
 *
 *   · http(s) only, no credentials in the URL, no credential-looking query
 *     parameter, standard ports only
 *   · the host is resolved here, EVERY address is checked against private,
 *     loopback, link-local, CGNAT, multicast and reserved ranges, and the
 *     socket is pinned to the checked address (a custom `lookup`), so a DNS
 *     answer cannot change between the check and the connect
 *   · redirects are followed manually, at most `maxRedirects`, each one
 *     re-validated the same way
 *   · a hard wall-clock timeout and a byte limit on the body; nothing is
 *     decompressed beyond the limit
 *
 * No cookies are sent, no referrer, and a plain descriptive user agent.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { isPrivateHost } from './links';

export class UnsafeTarget extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

export interface SafeResponse {
  status: number;
  finalUrl: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  /** Injected for tests: resolve a hostname to addresses. */
  resolve?: (host: string) => Promise<string[]>;
  /** Injected for tests: perform one request to an already-validated address. */
  transport?: (url: URL, address: string, init: { method: string; headers: Record<string, string>; maxBytes: number; signal: AbortSignal }) => Promise<Omit<SafeResponse, 'finalUrl'>>;
}

const CREDENTIAL_PARAM = /^(key|apikey|api[_-]?key|token|access[_-]?token|auth|secret|password|sig|signature|session|code)$/i;
const USER_AGENT = 'WITH-CLAUDE-directory-check/1.0 (+https://withclaude.in; import-time link and icon check)';

/** Throws `UnsafeTarget` for anything this module must never request. */
export function assertSafeUrl(input: string | URL): URL {
  let u: URL;
  try {
    u = new URL(String(input));
  } catch {
    throw new UnsafeTarget('not a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UnsafeTarget('scheme');
  if (u.username || u.password) throw new UnsafeTarget('credentials in URL');
  if (u.port && !['80', '443'].includes(u.port)) throw new UnsafeTarget('non-standard port');
  for (const name of u.searchParams.keys()) if (CREDENTIAL_PARAM.test(name)) throw new UnsafeTarget('credential-looking parameter');
  if (/(^|\/)admin(\/|$)/i.test(u.pathname)) throw new UnsafeTarget('admin route');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHost(host)) throw new UnsafeTarget('private host');
  if (!isIP(host) && !host.includes('.')) throw new UnsafeTarget('single-label host');
  return u;
}

async function defaultResolve(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const answers = await dnsLookup(host, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

function defaultTransport(
  url: URL,
  address: string,
  init: { method: string; headers: Record<string, string>; maxBytes: number; signal: AbortSignal },
): Promise<Omit<SafeResponse, 'finalUrl'>> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        // Pin the socket to the address we validated. SNI and the Host header
        // still use the hostname, so TLS verification is unchanged.
        // Node ≥ 20 asks with `{ all: true }` (happy eyeballs) and expects a list.
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          opts?.all ? cb(null, [{ address, family: isIP(address) }]) : cb(null, address, isIP(address))) as never,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > init.maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - init.maxBytes)));
            res.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (!truncated) resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
        });
        res.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const method = options.method ?? 'GET';
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const maxRedirects = options.maxRedirects ?? 4;
  const resolve = options.resolve ?? defaultResolve;
  const transport = options.transport ?? defaultTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    let url = assertSafeUrl(input);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await resolve(host);
      if (addresses.length === 0) throw new UnsafeTarget('no address');
      const bad = addresses.find((a) => isPrivateHost(a));
      if (bad) throw new UnsafeTarget('resolves to a private address');
      const response = await transport(url, addresses[0]!, {
        method,
        headers: { 'User-Agent': USER_AGENT, Accept: options.accept ?? '*/*', 'Accept-Encoding': 'identity' },
        maxBytes,
        signal: controller.signal,
      });
      const location = response.headers.location;
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === maxRedirects) throw new UnsafeTarget('too many redirects');
        url = assertSafeUrl(new URL(Array.isArray(location) ? location[0]! : location, url));
        continue;
      }
      return { ...response, finalUrl: url.toString() };
    }
    throw new UnsafeTarget('too many redirects');
  } finally {
    clearTimeout(timer);
  }
}
