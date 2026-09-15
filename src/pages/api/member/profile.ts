/**
 * PATCH /api/member/profile — edit your own passport.
 * POST  /api/member/profile — publish it.
 *
 * ── WHY THE MEMBER ID IS NOT A PARAMETER ─────────────────────────────────
 *
 * Because there is no version of this endpoint where the browser gets to say
 * whose profile it is editing. The member comes from `guardMutation()`, which
 * gets it from a verified token, and `updateProfile()` builds its WHERE clause
 * from that member. "Cannot edit another member's profile" is therefore not a
 * check that could be forgotten — there is no code path that takes a target.
 *
 * `profilePatchSchema` is `.strict()`, so a body carrying `memberId`,
 * `ownerMemberId`, `status`, `verified` or `roles` is REJECTED rather than
 * having those keys quietly dropped. Silently ignoring them would look like
 * success to whoever sent them, and the next person to read the code would
 * have no way to tell the difference between a field that is filtered and a
 * field that is honoured.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '../../../../db/pool';
import { guardMutation, json } from '@/server/http/guard';
import { profilePatchSchema, updateProfile, type ProfilePatch } from '@/server/members/profile';
import { publishProfile } from '@/server/members/publish';

export const prerender = false;

export const PATCH: APIRoute = async ({ request }) => {
  const db = pooledDb();

  const guard = await guardMutation<ProfilePatch>(request, db, {
    method: 'PATCH',
    schema: profilePatchSchema,
  });
  if (!guard.ok) return guard.response;

  // §18: status is checked by `requireMember`, but editing a PUBLIC profile is
  // a publishing act as much as an editing one, so a suspended member is
  // refused here as well as at publish.
  if (guard.member.status !== 'active') {
    return json({ error: 'This account cannot change its profile right now.' }, 403);
  }

  const result = await updateProfile(guard.member, guard.body, db);
  if (!result.ok) {
    return json({ error: result.error, field: result.field }, result.status);
  }

  return json(
    {
      profile: {
        username: result.profile.username,
        displayName: result.profile.displayName,
        headline: result.profile.headline,
        bio: result.profile.bio,
        cityId: result.profile.cityId,
        country: result.profile.country,
        website: result.profile.website,
        primaryRole: result.profile.primaryRole,
        claudeSince: result.profile.claudeSince,
        publicEmail: result.profile.publicEmail,
        visibility: result.profile.visibility,
        publishedAt: result.profile.publishedAt,
      },
    },
    200,
  );
};

/**
 * Publish. No body — publishing is a decision, not a payload.
 *
 * Everything published comes from the profile row as already saved, which
 * means there is no way for a publish request to smuggle in a field that the
 * PATCH validator would have rejected.
 */
export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();

  const guard = await guardMutation(request, db, { method: 'POST' });
  if (!guard.ok) return guard.response;

  const result = await publishProfile(guard.member, db);
  if (!result.ok) return json({ error: result.error }, result.status);

  return json(
    {
      slug: result.slug,
      created: result.created,
      url: `/builders/${result.slug}/`,
      /**
       * SAID PLAINLY, BECAUSE IT IS TRUE.
       *
       * Both /builders/ and /builders/[slug] are SSR (prerender = false) and
       * query Neon directly. The profile is live the moment the transaction
       * commits — no rebuild, no CDN purge, no waiting.
       */
      visibility: 'live',
      message: 'Published. Your profile is live on the builders directory.',
    },
    result.created ? 201 : 200,
  );
};

export const ALL: APIRoute = () =>
  json({ error: 'This endpoint accepts PATCH or POST.' }, 405, { Allow: 'PATCH, POST' });
