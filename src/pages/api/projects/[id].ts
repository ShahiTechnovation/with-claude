/**
 * EDIT A PROJECT.
 *
 * A partial update: only the keys present in the body are written, so the
 * editor can save one field without having to send — and therefore without
 * being able to accidentally blank — the rest.
 *
 * ── WHAT IS NOT EDITABLE HERE ────────────────────────────────────────────
 *
 * `ownerMemberId`, `slug`, `publicationStatus`, `moderationState`, `featured`,
 * `status`, and — since the cover became a media reference — `imagePath`. The schema is `.strict()`, so sending any of them is a 422 rather
 * than a silent no-op — which is the difference between a client learning it
 * is wrong and a client believing it changed the owner of a project.
 *
 * Publication moves through `/publish`, `/archive` and `/restore`, which have
 * the gates. Moderation moves only through the admin. And the slug is fixed at
 * creation because it is the public URL (see `nextAvailableSlug`).
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';
import { can, projectAccess } from '@/server/projects/lifecycle';
import { publishProjectCover, resolveCoverChoice } from '@/server/media/covers';
import { publishBlockers } from '@/server/members/projects';

export const prerender = false;

/**
 * A URL from a member, constrained to schemes a browser should follow.
 *
 * `z.string().url()` alone accepts `javascript:` and `data:`, and these values
 * are rendered as `href`s on a public page. That is stored XSS, so the scheme
 * is checked rather than assumed.
 *
 * Browser form semantics and API semantics disagree about empty. A cleared URL
 * field returns `""` from an HTML input; the column stores NULL. The transform
 * normalises that disagreement so an empty or whitespace-only value is always
 * null in the database — which is the correct representation of "no link" —
 * and non-empty values are validated strictly. This is the single coercion
 * point; the caller does not need to pre-process URL fields.
 */
export const httpUrl = z
  .string()
  .trim()
  .max(255)
  .transform((v) => (v === '' ? null : v))
  .pipe(
    z
      .string()
      .refine(
        (value) => {
          try {
            const { protocol } = new URL(value);
            return protocol === 'https:' || protocol === 'http:';
          } catch {
            return false;
          }
        },
        { message: 'Use a full http(s) link.' },
      )
      .nullable(),
  )
  .nullable();

const EditProjectSchema = z
  .object({
    title: z.string().trim().min(2).max(100).optional(),
    // `""` from a cleared input means "clear it" — the same coercion `httpUrl`
    // applies — so a member can remove a tagline as well as change one.
    summary: z
      .string()
      .trim()
      .max(300)
      .transform((v) => (v === '' ? null : v))
      .pipe(z.string().min(5, 'A tagline needs at least five characters.').nullable())
      .optional()
      .nullable(),
    description: z.string().trim().max(10_000).optional().nullable(),
    claudeUsage: z.string().trim().max(1_000).optional().nullable(),
    cityId: z.string().uuid().optional().nullable(),
    category: z.enum(schema.projectCategory.enumValues).optional(),
    url: httpUrl.optional(),
    repoUrl: httpUrl.optional(),
    videoUrl: httpUrl.optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
    /**
     * THE COVER IS A MEDIA ROW, NOT A URL.
     *
     * This replaced `imagePath`, which accepted any string and so let a client
     * point a project's cover at anything — bypassing the upload route's
     * ownership check entirely. `null` clears the cover. See
     * `src/server/media/covers.ts`.
     */
    coverMediaId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const PUT: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db, { method: 'PUT', schema: EditProjectSchema });
  if (!guard.ok) return guard.response;

  const { member, body } = guard;
  const projectId = params.id;
  if (!projectId) return json({ error: 'Missing project id.' }, 400);

  /**
   * Owner or collaborator — `can(role, 'edit')`. A contributor is credited,
   * not an editor, and gets a 403 that says so rather than a 404, because
   * they can already see the project in their account.
   */
  const access = await projectAccess(member.id, projectId, db);
  if (!access) return json({ error: 'Project not found.' }, 404);
  if (!can(access.role, 'edit')) {
    return json({ error: 'Contributors are credited on a project but cannot edit it.' }, 403);
  }
  if (access.project.contentAuthority !== 'member') {
    // Imported/unclaimed content is edited in the organisers' content tool
    // until a claim transfers it here. See docs/content-authority.md.
    return json({ error: 'This project is managed by the organisers until it is claimed.' }, 409);
  }

  // Only what was actually sent. `undefined` means absent; `null` means clear.
  const fields = [
    'title', 'summary', 'description', 'claudeUsage', 'cityId',
    'category', 'url', 'repoUrl', 'videoUrl', 'tags',
  ] as const;

  const update: Record<string, unknown> = {};
  for (const field of fields) {
    if (body[field] !== undefined) update[field] = body[field];
  }
  // Empty text means "no value", stored as NULL.
  for (const field of ['description', 'claudeUsage'] as const) {
    if (update[field] === '') update[field] = null;
  }

  if (body.coverMediaId !== undefined) {
    const cover = await resolveCoverChoice(db, projectId, body.coverMediaId);
    if (!cover.ok) return json({ error: cover.error, field: 'coverMediaId' }, cover.status);
    update.imageId = cover.imageId;
    update.imagePath = cover.imagePath;
  }

  if (update.cityId) {
    const [city] = await db
      .select({ id: schema.cities.id })
      .from(schema.cities)
      .where(and(eq(schema.cities.id, update.cityId as string), eq(schema.cities.status, 'published')));
    if (!city) return json({ error: 'That is not a city on the atlas.', field: 'cityId' }, 422);
  }

  if (Object.keys(update).length === 0) {
    return json({ error: 'Nothing to update.' }, 422);
  }

  /**
   * A PUBLIC project must stay publishable. Without this, clearing the
   * description of a live project would leave an incomplete page on the
   * website that the publish gate would never have let through.
   */
  if (access.project.publicationStatus === 'published') {
    const [current] = await db
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
    const blockers = publishBlockers({ ...current, ...update } as Parameters<typeof publishBlockers>[0]);
    if (blockers.length > 0) {
      return json(
        {
          error: 'A published project needs these fields. Archive it first if you want to remove them.',
          field: blockers[0].field,
          blockers,
        },
        422,
      );
    }
  }

  update.updatedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.update(schema.projects).set(update).where(eq(schema.projects.id, projectId));
    // A new cover on a project that is already public is public with it.
    if (update.imageId && access.project.publicationStatus === 'published') {
      await publishProjectCover(tx as never, projectId);
    }
    await tx.insert(schema.auditLog).values({
      actorMemberId: member.id,
      action: 'project.updated',
      entityType: 'project',
      entityId: projectId,
      // The changed FIELD NAMES, never their values — an audit row should not
      // become a second copy of a member's content.
      after: { fields: Object.keys(update).filter((key) => key !== 'updatedAt'), role: access.role },
    });
  });

  return json({ ok: true }, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'PUT' });
