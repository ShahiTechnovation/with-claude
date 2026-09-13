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
 * `verifyAccessToken()` from `@privy-io/node` does the cryptography. Signature,
 * issuer, audience (the app id) and expiry are all checked by the SDK, and it
 * throws rather than returning a falsy value if any of them fail.
 *
 * It is given a `verification_key`, which the installed SDK types as
 * `CryptoKey | JWTVerifyGetKey | string` — either the key itself or a
 * mechanism for fetching it. This project supplies whichever is available:
 * a static PEM when one is configured, and the app's published JWKS
 * otherwise. `verificationKeyFor()` decides, and explains why both paths have
 * to exist.
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
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

/** Preview diagnostics contain only fixed codes/booleans, never SDK errors or credentials. */
export function authTrace(event: 'request' | 'verification' | 'member', fields: Record<string, boolean | string>, env: NodeJS.ProcessEnv = process.env): void {
  if (env.VERCEL_ENV === 'preview') console.info(`[auth.${event}] ${JSON.stringify(fields)}`);
}

export function verificationFailureCode(error: unknown): string {
  const failure = error as { code?: string; claim?: string } | null;
  switch (failure?.code) {
    case 'ERR_JWT_EXPIRED': return 'EXPIRED';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED': return 'SIGNATURE_INVALID';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return failure.claim === 'aud' ? 'AUDIENCE_MISMATCH' : failure.claim === 'iss' ? 'ISSUER_MISMATCH' : 'TOKEN_INVALID';
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID': return 'TOKEN_INVALID';
    default: return 'UNKNOWN';
  }
}

// Diagnostic verification never authorizes a request. Only the Privy SDK below does.
async function diagnoseFailure(token: string, config: PrivyConfig): Promise<string> {
  const { importSPKI, jwtVerify } = await import('jose');
  // Only a static PEM can be diagnosed here. With a JWKS resolver the SDK's
  // own failure is already the whole answer, so there is nothing to add.
  if (!config.verificationKey) return 'UNKNOWN';
  let key;
  try { key = await importSPKI(config.verificationKey, 'ES256'); }
  catch { return 'VERIFICATION_KEY_INVALID'; }
  try {
    await jwtVerify(token, key, { typ: 'JWT', algorithms: ['ES256'], issuer: 'privy.io', audience: config.appId });
    return 'TOKEN_INVALID'; // Signature/claims passed but Privy's required payload shape did not.
  } catch (error) { return verificationFailureCode(error); }
}

/** The cookie Privy sets when cookie-based sessions are enabled. */
export const ACCESS_TOKEN_COOKIE = 'privy-token';

/** The cookie carrying the identity token, when identity tokens are enabled. */
export const IDENTITY_TOKEN_COOKIE = 'privy-id-token';


export interface PrivyConfig {
  appId: string;
  /**
   * The static PEM, when one is configured. OPTIONAL — see `verificationKeyFor()`.
   *
   * Empty string is treated as absent throughout, because that is how it
   * actually arrives: `vercel env pull` writes a declared-but-unset variable
   * as `PRIVY_VERIFICATION_KEY=""`, which a `Boolean()` check would happily
   * accept as configured.
   */
  verificationKey?: string;
}

/**
 * One JWKS resolver per app, reused across requests.
 *
 * `createRemoteJWKSet` keeps its own cache of the fetched key set and honours
 * cache headers, but only for the lifetime of the object — so building a new
 * one per request would mean a fetch to Privy per request. Module scope on a
 * warm serverless function is exactly the right lifetime for it.
 */
const jwksCache = new Map<string, JWTVerifyGetKey>();

/**
 * WHAT VERIFIES A TOKEN, AND WHY THERE ARE TWO ANSWERS.
 *
 * The installed `@privy-io/node` types `verification_key` as
 * `CryptoKey | JWTVerifyGetKey | string`, and its own doc comment says "the
 * verification key to use to verify the token, OR A MECHANISM TO GET IT SUCH
 * AS VIA JWKS", pointing at `createRemoteJWKSet`. So both are first-class in
 * the SDK contract; this is not a workaround.
 *
 * STATIC PEM, when `PRIVY_VERIFICATION_KEY` is set. Preferred, because
 * verification is then a local ES256 signature check with no network call at
 * all — the fastest and most available option.
 *
 * THE APP'S JWKS, otherwise. This exists because of a concrete problem:
 * `PRIVY_VERIFICATION_KEY` was not set in ANY environment — declared and
 * empty in Preview, absent in Production — so `privyConfig()` returned null
 * and every authenticated request answered 503 `not-configured`. The entire
 * account area was unreachable.
 *
 * It cannot simply be filled in from the published key set either, because
 * this app's JWKS serves TWO ES256 signing keys and nothing outside the Privy
 * dashboard says which one signs current tokens. Picking one would be a coin
 * flip that fails closed on the wrong call.
 *
 * A JWKS resolver has no such ambiguity: it selects by the token's own `kid`,
 * so it is correct for both keys and stays correct through a rotation that
 * would silently break a pinned PEM. The cost is a cached fetch to
 * `api.privy.io` on a cold start.
 *
 * NOTE: the JWKS endpoint is derived from `appId`, which comes from the
 * SERVER-side `PRIVY_APP_ID` and never from the browser's copy. See
 * `privyConfig()`.
 */
export function verificationKeyFor(config: PrivyConfig): string | JWTVerifyGetKey {
  const key = config.verificationKey?.trim();
  if (key) return key;

  const cached = jwksCache.get(config.appId);
  if (cached) return cached;

  const resolver = createRemoteJWKSet(
    new URL(`https://api.privy.io/v1/apps/${config.appId}/jwks.json`),
  );
  jwksCache.set(config.appId, resolver);
  return resolver;
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

  /**
   * THE APP ID IS THE ONLY HARD REQUIREMENT.
   *
   * It used to also require `PRIVY_VERIFICATION_KEY`, and that is what took
   * the account area down: the key was declared-but-empty in Preview and
   * absent in Production, so this returned null everywhere and every
   * authenticated request answered 503 `not-configured` — including for users
   * whose tokens were perfectly valid.
   *
   * The key is now optional because `verificationKeyFor()` can resolve the
   * app's published JWKS instead, which the installed SDK accepts directly.
   * An unconfigured APP ID is still a refusal, because without it there is
   * nothing to check a token's audience against and no JWKS to fetch — and
   * refusing is correct there, as `verifyRequest()` returns
   * `not-configured` rather than letting anything through.
   */
  if (!appId) return null;

  // Empty string means unset. `vercel env pull` writes a declared-but-unset
  // variable as `KEY=""`, and treating that as a configured key is precisely
  // the bug above.
  const verificationKey = env.PRIVY_VERIFICATION_KEY?.trim() || undefined;
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
  if (env.VERCEL_ENV === 'preview' && config) {
    const staticKey = config.verificationKey;
    const keyValid = staticKey
      ? await import('jose')
          .then(({ importSPKI }) => importSPKI(staticKey, 'ES256'))
          .then(
            () => true,
            () => false,
          )
      : false;
    authTrace('verification', {
      // `JWKS` is the healthy state when no static key is set, not a fault.
      key_source: staticKey ? (keyValid ? 'STATIC_PEM' : 'VERIFICATION_KEY_INVALID') : 'JWKS',
      pem_marker: staticKey?.startsWith('-----BEGIN PUBLIC KEY-----') ?? false,
      escaped_line_breaks: staticKey?.includes('\n') ?? false,
    }, env);
  }
  authTrace('request', {
    cookie_present: Boolean(readCookie(request, ACCESS_TOKEN_COOKIE)),
    authorization_present: Boolean(request.headers.get('authorization')),
    config_present: Boolean(config),
    app_id_match: !env.PUBLIC_PRIVY_APP_ID || !config ? 'UNKNOWN' : env.PUBLIC_PRIVY_APP_ID.trim() === config.appId ? 'MATCH' : 'MISMATCH',
  }, env);
  if (!config) {
    authTrace('verification', { result: 'CONFIG_MISSING' }, env);
    return { ok: false, reason: 'not-configured' };
  }

  const token = readAccessToken(request);
  if (!token) {
    authTrace('verification', { result: 'TOKEN_MISSING' }, env);
    return { ok: false, reason: 'no-token' };
  }

  try {
    const claims = await verifyAccessToken({
      access_token: token,
      app_id: config.appId,
      verification_key: verificationKeyFor(config),
    });
    // The SDK checks signature, issuer, audience and expiry and throws
    // otherwise. A verified token with no subject would still be unusable.
    if (!claims.user_id) {
      authTrace('verification', { result: 'TOKEN_INVALID' }, env);
      return { ok: false, reason: 'invalid-token' };
    }
    authTrace('verification', { result: 'verified' }, env);
    return { ok: true, privyUserId: claims.user_id };
  } catch {
    if (env.VERCEL_ENV === 'preview') {
      const code = await diagnoseFailure(token, config).catch(() => 'UNKNOWN');
      authTrace('verification', { result: code }, env);
    }
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
      verification_key: verificationKeyFor(config),
    });
    return { ok: true, user };
  } catch {
    return { ok: false, reason: 'invalid-token' };
  }
}
