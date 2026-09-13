/**
 * POST /api/member/bootstrap — turn a verified Privy login into a member.
 *
 * The only route that creates a `members` row, and the only one that may.
 *
 * ── WHY THIS IS NOT DONE ON READ ─────────────────────────────────────────
 *
 * The tempting shortcut is for `requireMember()` to create the row when it
 * does not find one, so nothing ever has to call this. That would make every
 * authenticated GET on every page a database write — a read path that inserts
 * cannot be rate-limited meaningfully, cannot be cached, and turns a page view
 * into a row somebody can manufacture at whatever rate they can request pages.
 *
 * So provisioning is one explicit POST, called once after login, and
 * everything else is a read.
 *
 * ── WHY IT TAKES NO BODY ─────────────────────────────────────────────────
 *
 * There is nothing a client could usefully say. The identity comes from the
 * verified token; the profile shell is derived from the member id. A body
 * would only be a place for somebody to try putting a `member_id`, which is
 * exactly the input this endpoint must not have.
 */
import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { verifyRequest } from '@/server/auth/privy';
import { ensureProfileShell, provisionMember, statusFor } from '@/server/auth/member';
import { assertSameOrigin, fetchSiteAllows } from '@/server/http/origin';
import { json } from '@/server/http/guard';
import { isPlaceholderUsername } from '@/server/members/username';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  if (!assertSameOrigin(request) || !fetchSiteAllows(request)) {
    return json({ error: 'That request did not come from this site.' }, 403);
  }

  // NOT `requireMember()` — this is the one route that runs BEFORE a member
  // exists, so it verifies the token directly and then creates the row.
  const identity = await verifyRequest(request);
  if (!identity.ok) {
    const status = statusFor(identity.reason);
    return json(
      {
        error:
          identity.reason === 'not-configured'
            ? 'Sign-in is not configured on this deployment.'
            : 'That sign-in could not be verified.',
        reason: identity.reason,
      },
      status,
    );
  }

  const db = pooledDb();

  const { member, created } = await provisionMember(identity.privyUserId, db);

  if (member.status !== 'active') {
    // A suspended account can still sign in with Privy — we do not control
    // that — but it gets no further here.
    return json({ error: 'This account is not active.', reason: member.status }, 403);
  }

  const shell = await ensureProfileShell(member, db);

  /**
   * Is this member also a verified ambassador? §43.
   *
   * The account menu shows an "Ambassador profile" item only when there is one
   * to show, which means the client has to be told. It is answered here rather
   * than by a second endpoint because this response is already the one call
   * the menu makes after login.
   *
   * ── WHY THE SLUG AND NOT A BOOLEAN ───────────────────────────────────────
   *
   * The menu needs somewhere to link to. A boolean would force the client to
   * construct the URL from a username, and an ambassador slug is NOT a
   * username — they are separate identifiers on separate tables, and guessing
   * one from the other is how a menu item starts 404ing for the people it is
   * for.
   *
   * `status = 'published'` because an unpublished ambassador record has no
   * public page. Linking to one would send the person it belongs to to a 404.
   */
  const [ambassador] = await db
    .select({ slug: schema.ambassadors.slug })
    .from(schema.ambassadors)
    .where(
      and(eq(schema.ambassadors.memberId, member.id), eq(schema.ambassadors.status, 'published')),
    );

  return json(
    {
      member: { id: member.id, status: member.status },
      created,
      profile: {
        username: shell.username,
        // What the passport flow needs to know: has this person chosen a
        // handle yet, or are they still on the placeholder?
        needsUsername: isPlaceholderUsername(shell.username),
      },
      /** Null for almost everyone. §25 — ambassador status is not an account tier. */
      ambassador: ambassador ? { slug: ambassador.slug } : null,
    },
    created ? 201 : 200,
  );
};

/** Anything else. A GET here would be a way to provision by navigation. */
export const ALL: APIRoute = () =>
  json({ error: 'This endpoint only accepts POST.' }, 405, { Allow: 'POST' });
