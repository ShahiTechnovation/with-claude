import type { APIRoute } from 'astro';
import { pooledDb } from '@db/pool';
import * as dbSchema from '@db/schema';
import { eq } from 'drizzle-orm';
import { assertSameOrigin } from '@/server/session';

export const prerender = false;

export const POST: APIRoute = async ({ request, params, locals }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') {
    return new Response(JSON.stringify({ error: 'Not authenticated as admin.' }), { status: 401 });
  }

  if (!assertSameOrigin(request)) {
    return new Response(JSON.stringify({ error: 'Cross-origin request refused.' }), { status: 403 });
  }

  const { id, action } = params;
  if (!id || !action) return new Response('Missing parameters.', { status: 400 });

  const validActions = ['dismiss', 'triage', 'investigate', 'resolve'];
  if (!validActions.includes(action)) {
    return new Response('Invalid action.', { status: 400 });
  }

  const db = pooledDb();
  
  // Transaction
  const success = await db.transaction(async (tx) => {
    const [report] = await tx.select().from(dbSchema.reports).where(eq(dbSchema.reports.id, id));
    if (!report) return false;

    let newStatus = report.status;
    if (action === 'dismiss') newStatus = 'dismissed';
    if (action === 'triage') newStatus = 'triaged';
    if (action === 'investigate') newStatus = 'investigating';
    if (action === 'resolve') newStatus = 'resolved';

    if (newStatus === report.status) return true; // No change needed

    await tx.update(dbSchema.reports)
      .set({ 
        status: newStatus as any, 
        updatedAt: new Date(),
        resolvedAt: (newStatus === 'resolved' || newStatus === 'dismissed') ? new Date() : null
      })
      .where(eq(dbSchema.reports.id, id));

    await tx.insert(dbSchema.auditLog).values({
      actorId: user.id,
      action: `report.${newStatus}`,
      entityType: 'report',
      entityId: id,
      fromStatus: report.status,
      toStatus: newStatus,
      note: `Report ${action}d by moderator`,
    });

    return true;
  });

  if (!success) {
    return new Response('Report not found or transaction failed.', { status: 404 });
  }

  // Redirect back
  return new Response(null, {
    status: 303,
    headers: { Location: `/reports/${id}`, 'Cache-Control': 'no-store' },
  });
};

export const ALL: APIRoute = () =>
  new Response('This endpoint only accepts POST.', { status: 405, headers: { Allow: 'POST' } });
