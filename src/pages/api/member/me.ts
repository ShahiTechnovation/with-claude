/**
 * GET /api/member/me — what the signed-in person may know about themselves.
 *
 * Two callers, one shape:
 *
 *   · the account island in the masthead, which needs a handle and a name so
 *     the 72 static pages can show who is signed in without shipping React
 *   · the `/me` pages, which read it server-side
 *
 * ── WHAT IT DELIBERATELY DOES NOT RETURN ─────────────────────────────────
 *
 * The Privy DID. It is an identifier for the authentication provider, the
 * browser has no use for it, and putting it in a JSON body means it ends up in
 * a devtools log and a bug report. Same reasoning for `member.id`: the client
 * never needs to name a member, because every endpoint derives the member from
 * the token. A client that cannot see an id cannot be tempted to send one.
 *
 * There is NO endpoint that returns another member's private fields, and no
 * parameter here to ask about anybody else. §8: not a general member database
 * endpoint.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '../../../../db/pool';
import { guardRead, json } from '@/server/http/guard';
import { readProfile } from '@/server/members/profile';
import { ownedBuilder } from '@/server/members/publish';
import { isPlaceholderUsername } from '@/server/members/username';
import { claimsFor } from '@/server/members/claims';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const db = pooledDb();

  const guard = await guardRead(request, db);
  if (!guard.ok) return guard.response;

  const profile = await readProfile(guard.member.id, db);
  if (!profile) {
    // Verified, has a member row, but bootstrap never finished. Tell the
    // client to run it rather than inventing a profile from a read.
    return json({ error: 'This account has no profile yet.', reason: 'no-profile' }, 409);
  }

  const builder = await ownedBuilder(guard.member, db);
  const claims = await claimsFor(guard.member.id, db);

  return json(
    {
      status: guard.member.status,
      profile: {
        username: profile.username,
        needsUsername: isPlaceholderUsername(profile.username),
        displayName: profile.displayName,
        headline: profile.headline,
        bio: profile.bio,
        cityId: profile.cityId,
        country: profile.country,
        website: profile.website,
        primaryRole: profile.primaryRole,
        claudeSince: profile.claudeSince,
        publicEmail: profile.publicEmail,
        visibility: profile.visibility,
        publishedAt: profile.publishedAt,
      },
      /** The public record they own, if any. Null before they publish. */
      builder: builder ? { slug: builder.slug, name: builder.name, source: builder.source } : null,
      claims: claims.map((c) => ({
        slug: c.slug,
        name: c.name,
        status: c.status,
        proofType: c.proofType,
      })),
    },
    200,
  );
};

export const ALL: APIRoute = () =>
  json({ error: 'This endpoint only accepts GET.' }, 405, { Allow: 'GET' });
