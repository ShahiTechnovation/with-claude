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

  const { type, id, action } = params;
  if (!type || !id || !action) return new Response('Missing parameters.', { status: 400 });

  const validActions = ['restrict', 'restore', 'archive', 'delete'];
  if (!validActions.includes(action)) {
    return new Response('Invalid action.', { status: 400 });
  }

  const db = pooledDb();
  
  // Transaction
  const success = await db.transaction(async (tx) => {
    let fromStatus = '';
    let toStatus = '';
    let dbAction = '';
    
    if (type === 'project') {
      const [entity] = await tx.select().from(dbSchema.projects).where(eq(dbSchema.projects.id, id));
      if (!entity) return false;
      fromStatus = entity.moderationState;
      
      if (action === 'restrict') toStatus = 'restricted';
      else if (action === 'restore') toStatus = 'clean'; // assuming restore sets to clean
      else if (action === 'delete') toStatus = 'removed';
      
      dbAction = `content.${toStatus === 'clean' ? 'restored' : toStatus}`;

      const updateData: any = { moderationState: toStatus as any, updatedAt: new Date() };
      if (action === 'delete') {
        updateData.deletedAt = new Date();
        updateData.deletedBy = user.id;
        updateData.deletionReason = 'Moderator removed';
      }

      await tx.update(dbSchema.projects).set(updateData).where(eq(dbSchema.projects.id, id));

    } else if (type === 'builder') {
      const [entity] = await tx.select().from(dbSchema.builders).where(eq(dbSchema.builders.id, id));
      if (!entity) return false;
      fromStatus = entity.moderationState;
      
      if (action === 'restrict') toStatus = 'restricted';
      else if (action === 'restore') toStatus = 'clean';
      else if (action === 'delete') toStatus = 'removed';

      dbAction = `content.${toStatus === 'clean' ? 'restored' : toStatus}`;

      const updateData: any = { moderationState: toStatus as any, updatedAt: new Date() };
      if (action === 'delete') {
        updateData.deletedAt = new Date();
        updateData.deletedBy = user.id;
        updateData.deletionReason = 'Moderator removed';
      }
      
      await tx.update(dbSchema.builders).set(updateData).where(eq(dbSchema.builders.id, id));

    } else if (type === 'media') {
      const [entity] = await tx.select().from(dbSchema.media).where(eq(dbSchema.media.id, id));
      if (!entity) return false;
      fromStatus = entity.status; // media uses status directly
      
      if (action === 'restrict' || action === 'delete') toStatus = 'deleted';
      else if (action === 'restore') toStatus = 'published';

      dbAction = `content.${toStatus === 'published' ? 'restored' : toStatus}`;

      const updateData: any = { status: toStatus as any, updatedAt: new Date() };
      if (action === 'delete') {
        updateData.deletedAt = new Date();
        updateData.deletedBy = user.id;
        updateData.deletionReason = 'Moderator removed';
      }
      
      await tx.update(dbSchema.media).set(updateData).where(eq(dbSchema.media.id, id));
    } else {
      return false; // unknown type
    }

    // Write audit log
    await tx.insert(dbSchema.auditLog).values({
      actorId: user.id,
      action: dbAction,
      entityType: type,
      entityId: id,
      fromStatus,
      toStatus,
      note: `Moderator executed ${action} on ${type}`,
    });

    return true;
  });

  if (!success) {
    return new Response('Entity not found or transaction failed.', { status: 404 });
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
