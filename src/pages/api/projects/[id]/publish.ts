/**
 * PUBLISH. INSTANTLY, AND WITHOUT AN EDITOR.
 *
 * §13: publishing is immediate for a normal user. There is no approval queue
 * for member-owned projects, and admin is reactive — it restricts what has
 * been reported, it does not gate what has been written.
 *
 * ── WHAT THIS STILL REFUSES ──────────────────────────────────────────────
 *
 * 1. A project that is not yours, or that you are only credited on — publish
 *    is owner-only (see the matrix in `src/server/projects/lifecycle.ts`).
 * 2. A project that has been restricted or removed by a moderator. Publishing
 *    is not a way out of moderation (§29), so a restricted project cannot be
 *    re-published by its owner.
 * 3. A project that is not COMPLETE. `publishBlockers()` enforces five
 *    required fields (title, summary, description, claudeUsage, cityId) and
 *    returns all of them at once so the editor can highlight every gap
 *    simultaneously.
 *
 * ── OWNER ATTRIBUTION ────────────────────────────────────────────────────
 *
 * After publication, the owner's Builder record (builders.ownerMemberId =
 * projects.ownerMemberId) is inserted into project_builders. This is what
 * makes the "Made by" sidebar link and the builder profile project list work
 * without a Git commit or nightly rebuild.
 *
 * The attribution uses ON CONFLICT DO NOTHING, so re-publishing or
 * concurrent publishes do not duplicate rows. If the member has not yet
 * published a Builder Passport (no row in builders for their memberId), the
 * project still publishes — attribution is best-effort rather than a
 * prerequisite. The member's builder row is inserted by the profile publish
 * path, not here.
 *
 * The whole operation is transactional: if the project update, the builder
 * attribution, or the audit log fails, none of the three commits.
 */
import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { pooledDb } from '../../../../../db/pool';
import * as schema from '../../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';
import { publishBlockers } from '@/server/members/projects';
import { transitionProject } from '@/server/projects/lifecycle';
import { publishProjectCover } from '@/server/media/covers';

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  // No body: publishing is an act, not a payload.
  const guard = await guardMutation(request, db);
  if (!guard.ok) return guard.response;

  const { member } = guard;
  const projectId = params.id;
  if (!projectId) return json({ error: 'Missing project id.' }, 400);

  let result;
  try {
    result = await transitionProject(db, member.id, projectId, 'publish', {
      // Completeness, checked against the row as saved — never the request.
      precheck: async () => {
        const [row] = await db
          .select({
            title: schema.projects.title,
            summary: schema.projects.summary,
            description: schema.projects.description,
            claudeUsage: schema.projects.claudeUsage,
            category: schema.projects.category,
            cityId: schema.projects.cityId,
          })
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId));
        const blockers = publishBlockers(row ?? {});
        if (blockers.length === 0) return null;
        return {
          ok: false,
          status: 422,
          error: blockers[0].message,
          // All of them, so the editor can mark up every missing field at once.
          blockers,
        };
      },
      within: async (tx, access) => {
        // Owner attribution, idempotent. Skipped (not failed) when the owner
        // has no published Builder Passport yet; profile publish backfills it.
        if (access.project.ownerMemberId) {
          const [ownerBuilder] = await tx
            .select({ id: schema.builders.id })
            .from(schema.builders)
            .where(eq(schema.builders.ownerMemberId, access.project.ownerMemberId));
          if (ownerBuilder) {
            await tx
              .insert(schema.projectBuilders)
              .values({ projectId, builderId: ownerBuilder.id, position: 0 })
              .onConflictDoNothing();
          }
        }
        // A staged cover becomes public with its project, not before.
        await publishProjectCover(tx, projectId);
      },
    });
  } catch (err) {
    console.error('[project.publish] transaction failed', err);
    return json({ error: 'Could not publish the project. Please try again.' }, 500);
  }

  if (!result.ok) {
    const { ok: _ok, status, ...body } = result;
    const first = (body.blockers as { field?: string }[] | undefined)?.[0];
    return json({ ...body, ...(first?.field ? { field: first.field } : {}) }, status);
  }

  /**
   * `/projects/[slug]` and `/projects/` are server-rendered and read Neon, so
   * the project is live the moment this returns, subject only to the bounded
   * public cache TTL documented in docs/caching.md.
   */
  return json(
    {
      ok: true,
      slug: result.slug,
      url: `/projects/${result.slug}/`,
      detailLive: true,
      listingLive: true,
    },
    200,
  );
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
