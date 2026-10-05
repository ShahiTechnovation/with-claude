/**
 * ONE MODERATOR ACTION, APPLIED TO ONE ROW.
 *
 * The route used to be three hand-copied per-type branches that each decided
 * for themselves what an action meant. Every decision now comes from
 * `moderationWrite()` in `@/server/moderation`, which is also where a test can
 * reach it; what is left here is the boundary — authenticate, validate, look
 * the row up, write, audit, redirect.
 *
 * The only thing that still differs per content type is which table holds the
 * row and which column holds its state. That is `TARGETS` below, and nothing
 * else.
 */
import type { APIRoute } from 'astro';
import { pooledDb } from '@db/pool';
import * as dbSchema from '@db/schema';
import { eq } from 'drizzle-orm';
import { assertSameOrigin } from '@/server/session';
import { moderationRequest, STATE_COLUMN, type ModeratableType } from '@/server/moderation';

export const prerender = false;

/** The table each content type lives in. See the file header. */
const TARGETS = {
  project: dbSchema.projects,
  builder: dbSchema.builders,
  media: dbSchema.media,
} satisfies Record<ModeratableType, unknown>;

/**
 * Every non-redirect response this route produces.
 *
 * `code` is the stable, machine-readable half and `error` the half a moderator
 * reads. Neither carries a driver message or a stack: a constraint violation
 * becomes `moderation_failed` here and the detail goes to the server log.
 */
function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ code, error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') {
    return fail(401, 'not_admin', 'Not authenticated as admin.');
  }

  if (!assertSameOrigin(request)) {
    return fail(403, 'cross_origin', 'Cross-origin request refused.');
  }

  // Parameter validation and the action mapping both live in
  // `@/server/moderation`, where a test can reach them.
  const parsed = moderationRequest(params, user.id);
  if (!parsed.ok) {
    return fail(parsed.status, parsed.code, parsed.error);
  }
  const { type, id, action, write } = parsed;

  const db = pooledDb();
  const table = TARGETS[type];
  const stateColumn = STATE_COLUMN[type];

  let found: boolean;
  try {
    found = await db.transaction(async (tx) => {
      // Drizzle cannot narrow a table selected by name from a map of three
      // different tables. The three agree on `id` and on the state column
      // named above, which is the entire contract this block needs.
      const rows = await tx
        .select()
        .from(table as never)
        .where(eq(table.id, id));
      const entity = rows[0] as Record<string, unknown> | undefined;
      if (!entity) return false;

      await tx
        .update(table as never)
        .set(write.columns as never)
        .where(eq(table.id, id));

      await tx.insert(dbSchema.auditLog).values({
        actorId: user.id,
        action: write.auditAction,
        entityType: type,
        entityId: id,
        fromStatus: String(entity[stateColumn] ?? ''),
        toStatus: write.state,
        note: `Moderator executed ${action} on ${type}`,
      });

      return true;
    });
  } catch (error) {
    // A write this route asked for was refused. The moderator gets something
    // they can act on and the operator gets the reason, which is the half that
    // was missing when `archive` wrote an empty string to an enum column.
    console.error(`moderation ${action} on ${type} ${id} failed`, error);
    return fail(
      500,
      'moderation_failed',
      `Could not ${action} this ${type}. The change was not saved.`,
    );
  }

  if (!found) {
    return fail(404, 'not_found', `No ${type} with that id.`);
  }

  // Note: For user-generated pages, targeted invalidation should happen here.
  // In a real Vercel environment, we would use the revalidate API.
  // For now, Astro will revalidate since ISR cache is set to 60s for dynamic pages.

  // Redirect back to referring page or reports
  const referer = request.headers.get('referer');
  return new Response(null, {
    status: 303,
    headers: { Location: referer || `/moderation`, 'Cache-Control': 'no-store' },
  });
};

export const ALL: APIRoute = () =>
  new Response('This endpoint only accepts POST.', { status: 405, headers: { Allow: 'POST' } });
