/**
 * POST /api/member/claim — "this existing profile is me".
 *
 * ── WHY THIS ROUTE NEEDS A SECOND TOKEN ──────────────────────────────────
 *
 * Every other member endpoint needs one fact: who is calling. The access token
 * answers that and nothing more — it carries a Privy DID and no linked
 * accounts, which is the right minimum for an authorisation decision.
 *
 * A claim needs a different fact: which GitHub or LinkedIn account Privy has
 * VERIFIED for this person. That lives in the identity token, so this is the
 * one route that asks for it. Verified locally with the same key, so it is
 * still no network call.
 *
 * Both are required. The access token establishes the member; the identity
 * token supplies the evidence. Using the identity token alone would mean
 * trusting a different credential than every other route trusts, and using
 * the access token alone would mean asking Privy's API for linked accounts on
 * every attempt.
 *
 * ── WHAT THE CLIENT MAY SAY ──────────────────────────────────────────────
 *
 * One thing: which builder slug they are claiming. It is a public identifier
 * that appears in a URL, so naming it gives away nothing, and it cannot be
 * used to claim anything — the proof still has to match. Everything else is
 * derived server-side.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { pooledDb } from '../../../../db/pool';
import { guardMutation, json } from '@/server/http/guard';
import { verifyIdentity } from '@/server/auth/privy';
import { attemptClaim } from '@/server/members/claims';

export const prerender = false;

/** A slug, and only a slug. `.strict()` refuses anything else in the body. */
const claimSchema = z
  .object({ slug: z.string().trim().min(1).max(120) })
  .strict();

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();

  const guard = await guardMutation<z.infer<typeof claimSchema>>(request, db, {
    method: 'POST',
    schema: claimSchema,
  });
  if (!guard.ok) return guard.response;

  const identity = await verifyIdentity(request);
  if (!identity.ok) {
    /**
     * A MISSING IDENTITY TOKEN IS A CONFIGURATION PROBLEM, NOT A REFUSAL.
     *
     * Identity tokens are an option in the Privy dashboard. If they are off,
     * the cookie is simply never set, and no amount of retrying by the person
     * clicking Claim will help. Saying "no proof found" would send them
     * looking for a mistake they did not make.
     */
    return json(
      {
        error:
          identity.reason === 'no-token'
            ? 'Automatic verification is unavailable on this deployment, so this claim needs a human. Try again shortly.'
            : 'That sign-in could not be verified.',
        reason: identity.reason,
      },
      identity.reason === 'no-token' ? 503 : 401,
    );
  }

  const result = await attemptClaim(guard.member, guard.body.slug, identity.user, db);
  if (!result.ok) return json({ error: result.error }, result.status);

  if (result.status === 'approved') {
    return json(
      {
        status: 'approved',
        slug: result.slug,
        proofType: result.proofType,
        url: `/builders/${result.slug}/`,
        message:
          'Verified — this profile is now yours. Your edits appear when the site next rebuilds.',
      },
      200,
    );
  }

  return json(
    {
      status: 'pending',
      slug: result.slug,
      /**
       * DELIBERATELY VAGUE ABOUT WHY.
       *
       * Explaining which proof was looked for and missed would tell somebody
       * attempting a claim on a record that is not theirs exactly which link
       * to go and add somewhere. §23: do not expose moderation internals.
       */
      message: 'Sent for review. We will check this by hand and let you know.',
    },
    202,
  );
};

export const ALL: APIRoute = () =>
  json({ error: 'This endpoint only accepts POST.' }, 405, { Allow: 'POST' });
