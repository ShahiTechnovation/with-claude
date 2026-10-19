import type { APIRoute } from 'astro';
import { pooledDb } from '@db/pool';
import * as dbSchema from '@db/schema';
import { eq } from 'drizzle-orm';
import { assertSameOrigin } from '@/server/session';
import { UUID, type ReportStatus } from '@/server/moderation';

export const prerender = false;

/**
 * The status each report action moves a report to, and its audit note in the
 * past tense. The audit log is append-only.
 */
const ACTIONS = {
  dismiss: { status: 'dismissed', note: 'Report dismissed by moderator' },
  triage: { status: 'triaged', note: 'Report triaged by moderator' },
  investigate: { status: 'investigating', note: 'Report investigated by moderator' },
  resolve: { status: 'resolved', note: 'Report resolved by moderator' },
} as const satisfies Record<string, { status: ReportStatus; note: string }>;

// `Object.hasOwn`, not `in`, which would accept `toString`.
const isReportAction = (a: string): a is keyof typeof ACTIONS => Object.hasOwn(ACTIONS, a);

export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Not authenticated as admin.' }), { status: 401 });
  }

  if (!assertSameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Cross-origin request refused.' }), {
      status: 403,
    });
  }

  const { id, action } = params;
  if (!id || !action) return new Response('Missing parameters.', { status: 400 });

  if (!isReportAction(action)) {
    return new Response('Invalid action.', { status: 400 });
  }
  if (!UUID.test(id)) {
    return new Response('Report id must be a UUID.', { status: 400 });
  }
  const { status: newStatus, note } = ACTIONS[action];

  const db = pooledDb();

  let found: boolean;
  try {
    found = await db.transaction(async (tx) => {
      // Locked, so a double-click waits for the first write and then finds
      // nothing to change, instead of logging the same change twice.
      const [report] = await tx
        .select()
        .from(dbSchema.reports)
        .where(eq(dbSchema.reports.id, id))
        .for('update');
      if (!report) return false;

      if (newStatus === report.status) return true;

      await tx
        .update(dbSchema.reports)
        .set({
          status: newStatus,
          updatedAt: new Date(),
          resolvedAt: newStatus === 'resolved' || newStatus === 'dismissed' ? new Date() : null,
        })
        .where(eq(dbSchema.reports.id, id));

      await tx.insert(dbSchema.auditLog).values({
        actorId: user.id,
        actorEmail: user.email,
        action: `report.${newStatus}`,
        entityType: 'report',
        entityId: id,
        fromStatus: report.status,
        toStatus: newStatus,
        note,
      });

      return true;
    });
  } catch (error) {
    console.error(`report ${action} on ${id} failed`, error);
    return new Response(`Could not ${action} this report. The change was not saved.`, {
      status: 500,
    });
  }

  if (!found) {
    return new Response('No report with that id.', { status: 404 });
  }

  return new Response(null, {
    status: 303,
    headers: { Location: `/reports/${id}`, 'Cache-Control': 'no-store' },
  });
};

export const ALL: APIRoute = () =>
  new Response('This endpoint only accepts POST.', { status: 405, headers: { Allow: 'POST' } });
