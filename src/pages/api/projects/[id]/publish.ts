import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { pooledDb } from '../../../../../db/pool';
import * as schema from '../../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  // No body required for this mutation
  const guard = await guardMutation(request, db);
  if (!guard.ok) return guard.response;

  const { member } = guard;
  const projectId = params.id;
  if (!projectId) return json({ error: 'Missing project ID' }, 400);

  const [project] = await db
    .select({ 
      id: schema.projects.id, 
      ownerMemberId: schema.projects.ownerMemberId,
      publicationStatus: schema.projects.publicationStatus,
      moderationState: schema.projects.moderationState
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));

  if (!project) return json({ error: 'Project not found' }, 404);
  
  if (project.ownerMemberId !== member.id) {
    const [collab] = await db
      .select({ memberId: schema.projectMembers.memberId })
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.memberId, member.id)));
    if (!collab) {
      return json({ error: 'Unauthorized' }, 403);
    }
  }

  if (project.publicationStatus === 'deleted') {
    return json({ error: 'Cannot publish a deleted project' }, 400);
  }

  if (project.moderationState === 'restricted' || project.moderationState === 'archived') {
    return json({ error: 'Cannot publish a restricted project' }, 403);
  }

  await db
    .update(schema.projects)
    .set({ publicationStatus: 'published', updatedAt: new Date() })
    .where(eq(schema.projects.id, projectId));

  return json({ ok: true }, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
