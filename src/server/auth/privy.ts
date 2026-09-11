/**
 * PRIVY, VERIFIED SERVER-SIDE.
 *
 * The only place in this codebase that turns a credential into an identity.
 * Nothing else parses a token, and nothing else may: the entire security
 * argument for the public write paths is that identity comes from here and
 * from nowhere the browser can influence.
 *
 * ── WHAT IS VERIFIED, AND BY WHOM ────────────────────────────────────────
 *
 * `verifyAccessToken()` from `@privy-io/node` does the cryptography. It is
 * given a `verification_key`, which the SDK requires, and that requirement is
 * the good news: with a key supplied the check is a local ES256 signature
 * verification with no network call to Privy at all. Signature, issuer,
 * audience (the app id) and expiry are all checked by the SDK, and it throws
 * rather than returning a falsy value if any of them fail.
 *
 * `@privy-io/server-auth` is NOT used. It is deprecated in favour of
 * `@privy-io/node` — npm says so outright — and it offers nothing this needs.
 * `verifyAuthToken` is likewise deprecated in favour of `verifyAccessToken`.
 *
 * ── TWO TOKENS, TWO JOBS ─────────────────────────────────────────────────
 *
 * ACCESS TOKEN — answers "who is calling?". Returns the Privy DID and nothing
 * else. This is what every authenticated request uses, because it is all
 * an authorisation decision needs.
 *
 * IDENTITY TOKEN — answers "what has Privy verified about them?". Returns a
 * parsed `User` with `linked_accounts`, which is what a claim proof compares
 * against a builder's curated GitHub or LinkedIn URL. Also verified locally.
 *
 * Reaching for the identity token on ordinary requests would be asking for
 * more than the request needs, so it is requested only by the claim path.
 *
 * ── WHAT THIS FILE WILL NOT DO ───────────────────────────────────────────
 *
 * It does not log tokens, ever, at any level, including on failure — a token
 * in a log line is a token in whatever reads logs. It does not accept a token
 * from a query string. It does not decode a token manually. And it does not
 * fall back to trusting anything when configuration is missing: an
 * unconfigured server refuses authenticated requests rather than accepting
 * them.
 */
import { verifyAccessToken, verifyIdentityToken } from '@privy-io/node';
import type { User } from '@privy-io/node/resources';

/** The cookie Privy sets when cookie-based sessions are enabled. */
export const ACCESS_TOKEN_COOKIE = 'privy-token';

/** The cookie carrying the identity token, when identity tokens are enabled. */
export const IDENTITY_TOKEN_COOKIE = 'privy-id-token';

export interface PrivyConfig {
  appId: string;
  verificationKey: string;
}

/**
 * Server-side Privy configuration, or an explanation of what is missing.
 *
 * Returns `null` rather than throwing so a route can answer 503 and say the
 * server is not configured, which is a different fact from a caller being
 * unauthenticated and should not be reported as one.
 *
 * `PUBLIC_PRIVY_APP_ID` is deliberately NOT read here. It is the same value,
 * but it is the browser's copy, and having the server verify tokens against a
 * variable that Astro inlines into a bundle would make a client-visible
 * setting load-bearing for a server-side security check.
 */
export function privyConfig(env: NodeJS.ProcessEnv = process.env): PrivyConfig | null {
  const appId = env.PRIVY_APP_ID?.trim();
  const verificationKey = env.PRIVY_VERIFICATION_KEY?.trim();
  if (!appId || !verificationKey) return null;
  return { appId, verificationKey };
}

/** Why an authenticated request could not be attributed to anybody. */
export type AuthFailure =
  /** No token was presented. An ordinary anonymous request. */
  | 'no-token'
  /** A token was presented and did not verify: bad signature, wrong app, expired. */
  | 'invalid-token'
  /** The server has no Privy credentials. Not the caller's fault. */
  | 'not-configured';

export type VerifiedIdentity = { ok: true; privyUserId: string } | { ok: false; reason: AuthFailure };

/**
 * Read the access token off a request.
 *
 * The cookie first, because that is what Privy's cookie sessions send and it
 * is what makes an SSR page able to know who is asking without any client
 * JavaScript. The `Authorization: Bearer` header second, for a caller holding
 * a token from the React SDK's `getAccessToken()`.
 *
 * A query parameter is deliberately not supported. A token in a URL ends up in
 * browser history, in `Referer` headers and in access logs.
 */
export function readAccessToken(request: Request): string | null {
  const bearer = request.headers.get('authorization');
  if (bearer?.startsWith('Bearer ')) {
    const value = bearer.slice('Bearer '.length).trim();
    if (value) return value;
  }
  return readCookie(request, ACCESS_TOKEN_COOKIE);
}

export function readIdentityToken(request: Request): string | null {
  return readCookie(request, IDENTITY_TOKEN_COOKIE);
}

/**
 * One cookie, by name, from the `Cookie` header.
 *
 * Hand-parsed rather than pulling in a dependency: the header is a simple
 * `a=b; c=d` list and Astro does not expose a cookie reader to a plain
 * `Request`. Values are URL-decoded because a JWT contains no characters that
 * need encoding but a cookie writer is free to encode anyway.
 */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Verify a request's access token and return the Privy DID.
 *
 * The DID is the ONLY thing this returns, and that is the point: a caller
 * cannot accidentally trust a display name, an email or a role that arrived
 * inside a token, because none of them are handed back.
 */
export async function verifyRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedIdentity> {
  const config = privyConfig(env);
  if (!config) return { ok: false, reason: 'not-configured' };

  const token = readAccessToken(request);
  if (!token) return { ok: false, reason: 'no-token' };

  try {
    const claims = await verifyAccessToken({
      access_token: token,
      app_id: config.appId,
      verification_key: config.verificationKey,
    });
    // The SDK checks signature, issuer, audience and expiry and throws
    // otherwise. A verified token with no subject would still be unusable.
    if (!claims.user_id) return { ok: false, reason: 'invalid-token' };
    return { ok: true, privyUserId: claims.user_id };
  } catch {
    // NOTHING FROM THE ERROR IS LOGGED. Privy's errors can carry the token or
    // fragments of it, and this is the one code path guaranteed to run on
    // hostile input.
    return { ok: false, reason: 'invalid-token' };
  }
}

/**
 * Verify the identity token and return what Privy has verified about the user.
 *
 * Only the claim path calls this. `linked_accounts` is the payload that
 * matters — `github_oauth` carries a `username`, `linkedin_oauth` carries a
 * `vanity_name` — and those are the two deterministic proofs Phase A accepts.
 */
export async function verifyIdentity(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true; user: User } | { ok: false; reason: AuthFailure }> {
  const config = privyConfig(env);
  if (!config) return { ok: false, reason: 'not-configured' };

  const token = readIdentityToken(request);
  if (!token) return { ok: false, reason: 'no-token' };

  try {
    const user = await verifyIdentityToken({
      identity_token: token,
      app_id: config.appId,
      verification_key: config.verificationKey,
    });
    return { ok: true, user };
  } catch {
    return { ok: false, reason: 'invalid-token' };
  }
}
