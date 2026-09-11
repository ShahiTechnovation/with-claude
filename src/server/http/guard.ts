/**
 * THE DOOR EVERY MEMBER MUTATION GOES THROUGH.
 *
 * Five routes need the same six things done in the same order, and the order
 * is not arbitrary:
 *
 *   1. method            a GET must never reach a mutation
 *   2. same-origin       CSRF, before anything is read or parsed
 *   3. content type      JSON only, so a form POST cannot be smuggled in
 *   4. body size         bounded before it is parsed, not after
 *   5. identity          verified Privy token → member row → status
 *   6. schema            the body, validated, with unknown keys refused
 *
 * Putting it in one place is not tidiness. It is so that adding a sixth route
 * cannot accidentally skip step 2, which is the failure mode that makes CSRF
 * bugs so common — the check is per-route, so the newest route is the one
 * without it.
 *
 * A route that calls `guardMutation()` cannot skip a step, and a route that
 * does not call it is obvious in review.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import * as schema from '../../../db/schema';
import { requireMember, statusFor, type Member, type MemberFailure } from '../auth/member';
import { assertSameOrigin, fetchSiteAllows } from './origin';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Bodies here are a handful of short strings. 16 KB is already generous. */
export const MAX_BODY_BYTES = 16 * 1024;

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Never cached, never indexed. An authenticated response sitting in a
      // shared cache is somebody else's profile served to the wrong person.
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      ...headers,
    },
  });
}

/** The message a caller sees for each way identity can fail. */
function messageFor(reason: MemberFailure): string {
  switch (reason) {
    case 'not-configured':
      return 'Sign-in is not configured on this deployment.';
    case 'no-token':
      return 'Sign in to do that.';
    case 'invalid-token':
      return 'That sign-in has expired. Sign in again.';
    case 'no-member':
      return 'This account has not finished signing up.';
    case 'suspended':
      return 'This account is suspended.';
    case 'deleted':
      return 'This account has been closed.';
  }
}

export type Guarded<T> =
  | { ok: true; member: Member; body: T }
  | { ok: false; response: Response };

/**
 * Run all six checks. Returns either a member and a parsed body, or the
 * response to send instead.
 *
 * `schema` may be omitted for a mutation with no body.
 */
export async function guardMutation<T>(
  request: Request,
  db: AnyDatabase,
  options: { method?: string; schema?: z.ZodType<T> } = {},
): Promise<Guarded<T>> {
  const method = options.method ?? 'POST';

  if (request.method !== method) {
    return {
      ok: false,
      response: json({ error: `This endpoint only accepts ${method}.` }, 405, { Allow: method }),
    };
  }

  // BEFORE the body is touched. A CSRF refusal must not depend on parsing
  // anything an attacker controls.
  if (!assertSameOrigin(request) || !fetchSiteAllows(request)) {
    return { ok: false, response: json({ error: 'That request did not come from this site.' }, 403) };
  }

  const type = request.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    return { ok: false, response: json({ error: 'Send JSON.' }, 415) };
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json({ error: 'That request is too large.' }, 413) };
  }

  const identity = await requireMember(request, db);
  if (!identity.ok) {
    return {
      ok: false,
      response: json({ error: messageFor(identity.reason), reason: identity.reason }, statusFor(identity.reason)),
    };
  }

  if (!options.schema) {
    return { ok: true, member: identity.member, body: undefined as T };
  }

  let raw: unknown;
  try {
    const text = await request.text();
    // The real bound, in case `Content-Length` lied or was absent.
    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, response: json({ error: 'That request is too large.' }, 413) };
    }
    raw = JSON.parse(text || '{}');
  } catch {
    return { ok: false, response: json({ error: 'That request body is not JSON.' }, 400) };
  }

  const parsed = options.schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      response: json(
        { error: first?.message ?? 'That is not valid.', field: first?.path?.join('.') },
        422,
      ),
    };
  }

  return { ok: true, member: identity.member, body: parsed.data };
}

/**
 * The read-only counterpart, for `GET /api/member/me`.
 *
 * No origin check: a GET is not state-changing, and a cross-origin read is
 * already prevented by the browser's own same-origin policy — the response
 * carries no CORS headers, so a page on another site cannot read it even
 * though the cookie would be sent. Adding an `Origin` requirement here would
 * only break same-origin navigations that omit the header.
 */
export async function guardRead(
  request: Request,
  db: AnyDatabase,
): Promise<{ ok: true; member: Member } | { ok: false; response: Response }> {
  if (request.method !== 'GET') {
    return {
      ok: false,
      response: json({ error: 'This endpoint only accepts GET.' }, 405, { Allow: 'GET' }),
    };
  }

  const identity = await requireMember(request, db);
  if (!identity.ok) {
    return {
      ok: false,
      response: json({ error: messageFor(identity.reason), reason: identity.reason }, statusFor(identity.reason)),
    };
  }

  return { ok: true, member: identity.member };
}
