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
 * `status`. The schema is `.strict()`, so sending any of them is a 422 rather
 * than a silent no-op — which is the difference between a client learning it
 * is wrong and a client believing it changed the owner of a project.
 *
 * Publication moves through `/publish`, `/archive` and `/restore`, which have
 * the gates. Moderation moves only through the admin. And the slug is fixed at
 * creation because it is the public URL (see `nextAvailableSlug`).
 */
import type { APIRoute } from 'astro';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';
import { canEditProject } from '@/server/members/projects';

export const prerender = false;

/**
 * A URL from a member, constrained to schemes a browser should follow.
 *
 * `z.string().url()` alone accepts `javascript:` and `data:`, and these values
 * are rendered as `href`s on a public page. That is stored XSS, so the scheme
 * is checked rather than assumed.
 */
const httpUrl = z
  .string()
  .trim()
  .max(255)
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
  );

const EditProjectSchema = z
  .object({
    title: z.string().trim().min(2).max(100).optional(),
    summary: z.string().trim().min(5).max(300).optional().nullable(),
    description: z.string().trim().max(10_000).optional().nullable(),
    claudeUsage: z.string().trim().max(1_000).optional().nullable(),
    cityId: z.string().uuid().optional().nullable(),
    category: z.enum(schema.projectCategory.enumValues).optional(),
    url: httpUrl.optional().nullable(),
    repoUrl: httpUrl.optional().nullable(),
    videoUrl: httpUrl.optional().nullable(),
    imagePath: z.string().trim().max(255).optional().nullable(),
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
   * One authorisation helper, shared with the pages.
   *
   * This route previously inlined its own owner-then-collaborator check, as
   * did `/publish`, `/archive` and `/restore` — four copies of the same rule,
   * which is four chances for the newest one to be subtly different. §61.
   */
  if (!(await canEditProject(member.id, projectId, db))) {
    // Indistinguishable from "no such project", deliberately.
    return json({ error: 'Project not found.' }, 404);
  }

  // Only what was actually sent. `undefined` means absent; `null` means clear.
  const fields = [
    'title', 'summary', 'description', 'claudeUsage', 'cityId',
    'category', 'url', 'repoUrl', 'videoUrl', 'imagePath',
  ] as const;

  const update: Record<string, unknown> = {};
  for (const field of fields) {
    if (body[field] !== undefined) update[field] = body[field];
  }

  if (Object.keys(update).length === 0) {
    return json({ error: 'Nothing to update.' }, 422);
  }

  update.updatedAt = new Date();

  await db.update(schema.projects).set(update).where(eq(schema.projects.id, projectId));

  await db.insert(schema.auditLog).values({
    actorMemberId: member.id,
    action: 'project.updated',
    entityType: 'project',
    entityId: projectId,
    // The changed FIELD NAMES, never their values — an audit row should not
    // become a second copy of a member's content.
    after: { fields: Object.keys(update).filter((key) => key !== 'updatedAt') },
  });

  return json({ ok: true }, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'PUT' });
