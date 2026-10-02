/**
 * POST /api/projects/claims/ — ask to take over an imported project.
 *
 * Creates a PENDING claim and nothing else. Ownership moves only when a
 * moderator approves it in the admin; see `src/server/projects/claims.ts`.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { pooledDb } from '../../../../../db/pool';
import { guardMutation, json } from '@/server/http/guard';
import { requestProjectClaim } from '@/server/projects/claims';

export const prerender = false;

const ClaimSchema = z
  .object({
    projectSlug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,120}$/),
    evidence: z.string().trim().min(10).max(2_000),
  })
  .strict();

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db, { schema: ClaimSchema });
  if (!guard.ok) return guard.response;
  const result = await requestProjectClaim(db, guard.member.id, guard.body.projectSlug, guard.body.evidence);
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ ok: true, claimId: result.claimId, status: 'pending' }, 201);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
