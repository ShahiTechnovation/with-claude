/**
 * PUBLISH. INSTANTLY, AND WITHOUT AN EDITOR.
 *
 * §13: publishing is immediate for a normal user. There is no approval queue
 * for member-owned projects, and admin is reactive — it restricts what has
 * been reported, it does not gate what has been written.
 *
 * ── WHAT THIS STILL REFUSES ──────────────────────────────────────────────
 *
 * 1. A project that is not yours.
 * 2. A project that has been restricted or removed by a moderator. Publishing
 *    is not a way out of moderation (§29), so a restricted project cannot be
 *    re-published by its owner.
 * 3. A project that is not COMPLETE. This is the one that is easy to get
 *    wrong: migration 0010 made `city_id` and `summary` nullable so drafts
 *    could be saved, and `Project.citySlug` in `src/data/types.ts` is still a
 *    required string that the prerendered pages dereference. Publishing an
 *    incomplete project would therefore break the build rather than look
 *    untidy — so `publishBlockers()` runs here, and 422 is a real answer.
 */
import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { pooledDb } from '../../../../../db/pool';
import * as schema from '../../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';
import { publishBlockers } from '@/server/members/projects';

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  // No body: publishing is an act, not a payload.
  const guard = await guardMutation(request, db);
  if (!guard.ok) return guard.response;

  const { member } = guard;
  const projectId = params.id;
  if (!projectId) return json({ error: 'Missing project id.' }, 400);

  const [project] = await db
    .select({
      id: schema.projects.id,
      slug: schema.projects.slug,
      title: schema.projects.title,
      summary: schema.projects.summary,
      cityId: schema.projects.cityId,
      ownerMemberId: schema.projects.ownerMemberId,
      publicationStatus: schema.projects.publicationStatus,
      moderationState: schema.projects.moderationState,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));

  // 404 for both "no such project" and "not yours", so this cannot be used to
  // discover which ids exist.
  if (!project) return json({ error: 'Project not found.' }, 404);

  if (project.ownerMemberId !== member.id) {
    const [collaborator] = await db
      .select({ memberId: schema.projectMembers.memberId })
      .from(schema.projectMembers)
      .where(
        and(
          eq(schema.projectMembers.projectId, projectId),
          eq(schema.projectMembers.memberId, member.id),
        ),
      );
    if (!collaborator) return json({ error: 'Project not found.' }, 404);
  }

  if (project.publicationStatus === 'deleted') {
    return json({ error: 'That project has been deleted.' }, 409);
  }

  /**
   * Moderation outranks the owner. §29: publishing is instant, but a
   * moderator's restriction is not something an owner can undo by pressing
   * publish again.
   */
  if (
    project.moderationState === 'restricted' ||
    project.moderationState === 'removed' ||
    project.moderationState === 'archived'
  ) {
    return json({ error: 'That project is under moderation review.' }, 403);
  }

  const blockers = publishBlockers(project);
  if (blockers.length > 0) {
    return json(
      {
        error: blockers[0].message,
        field: blockers[0].field,
        // All of them, so the editor can mark up every missing field at once
        // rather than making the member publish repeatedly to find them.
        blockers,
      },
      422,
    );
  }

  const now = new Date();
  await db
    .update(schema.projects)
    .set({
      publicationStatus: 'published',
      /**
       * The curated archive's editorial status moves too, so the two
       * vocabularies agree about a row that is on the website. It is NOT how
       * visibility is decided — `src/data/source-db.ts` filters on
       * `publicationStatus` and `moderationState` — but leaving it at `draft`
       * would make the admin's own listings describe a live project as unwritten.
       */
      status: 'published',
      updatedAt: now,
    })
    .where(eq(schema.projects.id, projectId));

  await db.insert(schema.auditLog).values({
    actorMemberId: member.id,
    action: 'project.published',
    entityType: 'project',
    entityId: projectId,
    fromStatus: project.publicationStatus,
    toStatus: 'published',
    note: project.slug,
  });

  /**
   * WHEN IT ACTUALLY APPEARS, STATED HONESTLY.
   *
   * `/projects/[slug]` is server-rendered, so the detail page is live the
   * moment this returns — §14's requirement that a new project not need a Git
   * push to exist. The LISTING and the search index are prerendered, so they
   * pick it up at the next build, which the nightly rebuild guarantees. The
   * response says so rather than letting the UI imply instant everywhere.
   */
  return json(
    {
      ok: true,
      slug: project.slug,
      url: `/projects/${project.slug}/`,
      detailLive: true,
      listingRefreshesOnNextBuild: true,
    },
    200,
  );
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
