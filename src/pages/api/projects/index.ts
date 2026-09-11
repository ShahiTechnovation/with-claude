import type { APIRoute } from 'astro';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { pooledDb } from '../../../../db/pool';
import * as schema from '../../../../db/schema';
import { guardMutation, json } from '@/server/http/guard';

export const prerender = false;

const CreateProjectSchema = z.object({
  title: z.string().trim().min(2).max(100),
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
  ]).default('product'),
});

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export const POST: APIRoute = async ({ request }) => {
  const db = pooledDb();
  const guard = await guardMutation(request, db, { schema: CreateProjectSchema });
  if (!guard.ok) return guard.response;

  const { member, body } = guard;

  let baseSlug = slugify(body.title);
  if (!baseSlug) baseSlug = 'project';

  // Find a unique slug
  let slug = baseSlug;
  let counter = 1;
  while (true) {
    const existing = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(eq(schema.projects.slug, slug));
    if (existing.length === 0) break;
    slug = `${baseSlug}-${counter++}`;
  }

  const [project] = await db
    .insert(schema.projects)
    .values({
      ownerMemberId: member.id,
      slug,
      title: body.title,
      summary: body.summary ?? null,
      description: body.description ?? null,
      claudeUsage: body.claudeUsage ?? null,
      cityId: body.cityId ?? null,
      category: body.category,
      publicationStatus: 'draft',
      moderationState: 'clean',
      status: 'draft',
      featured: false,
    } as any).returning({ id: schema.projects.id, slug: schema.projects.slug });

  // Add the owner as a collaborator
  await db.insert(schema.projectMembers).values({
    projectId: project.id,
    memberId: member.id,
    role: 'collaborator',
  });

  return json({ id: project.id, slug: project.slug }, 201);
};
