/**
 * A MEMBER'S PROJECTS: LIST, AND CREATE.
 *
 * Creation is the change §13 is about. A member publishes without an editor
 * approving it, so the route that makes a project is a member route and not an
 * admin one. What it creates is a DRAFT — publishing is a separate, deliberate
 * act at `/api/projects/[id]/publish`.
 *
 * ── THE BUG THIS ROUTE USED TO HAVE ──────────────────────────────────────
 *
 * It inserted `cityId: null` and `summary: null` into columns that were
 * `NOT NULL`, so every single project creation failed at the database with a
 * 500. Migration 0010 made those columns nullable for drafts and moved the
 * completeness requirement to the publish boundary, where
 * `publishBlockers()` enforces it.
 *
 * It also inserted the owner into `project_members` as a `collaborator`, which
 * made every owner their own collaborator. Ownership is `owner_member_id` and
 * only that — see the header of `src/server/members/projects.ts`.
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { guardMutation, guardRead, json } from '@/server/http/guard';
import { getMemberProjects, nextAvailableSlug } from '@/server/members/projects';

export const prerender = false;

/**
 * What may be sent when creating a project.
 *
 * Only `title` is required, which is §11's "creation should be simple" taken
 * literally: a member types a name and gets a draft to work on. Everything
 * else can arrive later, and the publish gate is what insists on the rest.
 *
 * `.strict()` so an unknown key is a 422 rather than being silently dropped —
 * a client sending `ownerMemberId` should be told no, not ignored.
 */
const CreateProjectSchema = z
  .object({
    title: z.string().trim().min(2).max(100),
    summary: z.string().trim().min(5).max(300).optional().nullable(),
    description: z.string().trim().max(10_000).optional().nullable(),
    claudeUsage: z.string().trim().max(1_000).optional().nullable(),
    cityId: z.string().uuid().optional().nullable(),
    category: z
      .enum(schema.projectCategory.enumValues)
      .default('product'),
  })
  .strict();

/** The account island's own project list; identity comes from the token. */
export const GET: APIRoute = async ({ request }) => {
  const db = pooledDb();
  const guard = await guardRead(request, db);
  if (!guard.ok) return guard.response;
  return json(await getMemberProjects(guard.member.id, db), 200);
};

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db, { schema: CreateProjectSchema });
  if (!guard.ok) return guard.response;

  const { member, body } = guard;

  const slug = await nextAvailableSlug(body.title, db);

  const [project] = await db
    .insert(schema.projects)
    .values({
      /**
       * THE OWNER IS THE CALLER. Not a value from the body.
       *
       * §10 requires this to be server-side, and the schema above is
       * `.strict()` so a client cannot even send an `ownerMemberId` to be
       * ignored — it is rejected outright.
       */
      ownerMemberId: member.id,
      slug,
      title: body.title,
      // Nullable by migration 0010. Required by `publishBlockers()`, later.
      summary: body.summary ?? null,
      description: body.description ?? null,
      claudeUsage: body.claudeUsage ?? null,
      cityId: body.cityId ?? null,
      category: body.category,
      publicationStatus: 'draft',
      moderationState: 'clean',
      // The curated archive's editorial state. A member draft is a draft in
      // both vocabularies; publishing moves only `publicationStatus`.
      status: 'draft',
      featured: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: schema.projects.id, slug: schema.projects.slug });

  // §30. Append-only, attributed to the member rather than to a moderator.
  await db.insert(schema.auditLog).values({
    actorMemberId: member.id,
    action: 'project.created',
    entityType: 'project',
    entityId: project.id,
    toStatus: 'draft',
    note: project.slug,
  });

  return json({ id: project.id, slug: project.slug }, 201);
};

export const ALL: APIRoute = () =>
  json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
