/**
 * GET /api/cities — public list of active cities with their DB IDs.
 *
 * Used by client-side components (ProjectEditor) that need the canonical
 * city UUIDs from the database. The static `src/data/cities.ts` fixture uses
 * slug-style string IDs (e.g. 'city-bhopal') which are NOT the DB UUIDs that
 * `projects.cityId` references. This endpoint is the authoritative source.
 *
 * Returns: [{ id: UUID, name: string, slug: string }]
 *
 * Only cities with status = 'published' are returned — draft or hidden cities
 * are not selectable for a member project.
 */
import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { pooledDb } from '../../../db/pool';
import * as schema from '../../../db/schema';
import { json } from '@/server/http/guard';

export const prerender = false;

export const GET: APIRoute = async () => {
  const db = pooledDb();
  const rows = await db
    .select({
      id: schema.cities.id,
      name: schema.cities.name,
      slug: schema.cities.slug,
    })
    .from(schema.cities)
    .where(eq(schema.cities.status, 'published'))
    .orderBy(schema.cities.name);

  return json(rows, 200);
};

export const ALL: APIRoute = () => json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
