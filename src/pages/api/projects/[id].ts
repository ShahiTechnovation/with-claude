import type { APIRoute } from 'astro';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';

export const prerender = false;

const EditProjectSchema = z.object({
  title: z.string().trim().min(2).max(100).optional(),
  summary: z.string().trim().min(5).max(300).optional().nullable(),
  description: z.string().trim().max(10000).optional().nullable(),
  claudeUsage: z.string().trim().max(1000).optional().nullable(),
  cityId: z.string().uuid().optional().nullable(),
  category: z.enum([
    'product',
    'agent',
    'developer-tool',
    'research',
    'creative',
    'campus',
    'experiment',
    'startup',
  ]).optional(),
  url: z.string().url().max(255).optional().nullable(),
  repoUrl: z.string().url().max(255).optional().nullable(),
  videoUrl: z.string().url().max(255).optional().nullable(),
  imagePath: z.string().max(255).optional().nullable(),
});

export const PUT: APIRoute = async ({ request, params }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db, { method: 'PUT', schema: EditProjectSchema });
  if (!guard.ok) return guard.response;

  const { member, body } = guard;
  const projectId = params.id;
  if (!projectId) return json({ error: 'Missing project ID' }, 400);

  // Check ownership
  const [project] = await db
    .select({ id: schema.projects.id, ownerMemberId: schema.projects.ownerMemberId })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));

  if (!project) return json({ error: 'Project not found' }, 404);
  if (project.ownerMemberId !== member.id) {
    // Check if they are a collaborator
    const [collab] = await db
      .select({ memberId: schema.projectMembers.memberId })
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.memberId, member.id)));
    if (!collab) {
      return json({ error: 'Unauthorized to edit this project' }, 403);
    }
  }

  // Prevent modifying fields to undefined if they were not sent
  const updateData: Record<string, any> = { updatedAt: new Date() };
  if (body.title !== undefined) updateData.title = body.title;
  if (body.summary !== undefined) updateData.summary = body.summary;
  if (body.description !== undefined) updateData.description = body.description;
  if (body.claudeUsage !== undefined) updateData.claudeUsage = body.claudeUsage;
  if (body.cityId !== undefined) updateData.cityId = body.cityId;
  if (body.category !== undefined) updateData.category = body.category;
  if (body.url !== undefined) updateData.url = body.url;
  if (body.repoUrl !== undefined) updateData.repoUrl = body.repoUrl;
  if (body.videoUrl !== undefined) updateData.videoUrl = body.videoUrl;
  if (body.imagePath !== undefined) updateData.imagePath = body.imagePath;

  if (Object.keys(updateData).length > 1) { // more than just updatedAt
    await db
      .update(schema.projects)
      .set(updateData)
      .where(eq(schema.projects.id, projectId));
  }

  return json({ ok: true }, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'PUT' });
