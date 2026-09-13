import { eq, and, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { pooledDb } from '../../db/pool';
import * as dbSchema from '../../db/schema';

/**
 * The connection type every query in this module accepts.
 *
 * Driver-agnostic — `PgDatabase<PgQueryResultHKT, ...>` rather than
 * `ReturnType<typeof pooledDb>` — for the same reason
 * `src/server/members/projects.ts` and `src/server/events/sync.ts` define
 * their own `AnyDatabase` this way: `pooledDb()` is backed by `node-postgres`
 * in production, but `createTestDatabase()` hands a test a PGlite-backed
 * session. Pinning the parameter to the concrete production driver type would
 * make every test call a type error despite passing a perfectly good
 * `PgDatabase` at runtime — which is exactly what broke here the first time.
 *
 * Defaulted to `pooledDb()` at each call site rather than opened once at
 * module scope, so a page gets a fresh pooled connection per request and a
 * test can inject its own database instead.
 */
type Db = PgDatabase<PgQueryResultHKT, typeof dbSchema>;

export async function getBuilderRow(slug: string) {
  const db = pooledDb();
  const [row] = await db.select().from(dbSchema.builders).where(eq(dbSchema.builders.slug, slug));
  return row;
}

export async function getProjectData(slug: string) {
  const db = pooledDb();
  
  const [projectRow] = await db
    .select()
    .from(dbSchema.projects)
    .where(eq(dbSchema.projects.slug, slug));
    
  if (!projectRow) return null;

  const builderRows = await db
    .select({ builderId: dbSchema.projectBuilders.builderId })
    .from(dbSchema.projectBuilders)
    .where(eq(dbSchema.projectBuilders.projectId, projectRow.id));

  const builderSlugs = [];
  for (const row of builderRows) {
    const [b] = await db.select({ slug: dbSchema.builders.slug }).from(dbSchema.builders).where(eq(dbSchema.builders.id, row.builderId));
    if (b) builderSlugs.push(b.slug);
  }

  const citySlug = projectRow.cityId 
    ? (await db.select({slug: dbSchema.cities.slug}).from(dbSchema.cities).where(eq(dbSchema.cities.id, projectRow.cityId)))[0]?.slug 
    : '';

  return { projectRow, builderSlugs, citySlug };
}

export async function getPublicProjects() {
  const db = pooledDb();
  const projectRows = await db
    .select()
    .from(dbSchema.projects)
    .where(and(eq(dbSchema.projects.publicationStatus, 'published'), eq(dbSchema.projects.moderationState, 'clean')))
    .orderBy(dbSchema.projects.position);

  const allBuilderRows = await db.select({ projectId: dbSchema.projectBuilders.projectId, builderId: dbSchema.projectBuilders.builderId }).from(dbSchema.projectBuilders);
  const allBuilders = await db.select({ id: dbSchema.builders.id, slug: dbSchema.builders.slug }).from(dbSchema.builders);
  const allCities = await db.select({ id: dbSchema.cities.id, slug: dbSchema.cities.slug }).from(dbSchema.cities);

  return { projectRows, allBuilderRows, allBuilders, allCities };
}

export async function getPublicBuilderList(db: Db = pooledDb()) {
  const builderRows = await db
    .select({
      builder: dbSchema.builders,
      citySlug: dbSchema.cities.slug,
      media: dbSchema.media,
    })
    .from(dbSchema.builders)
    .innerJoin(dbSchema.cities, eq(dbSchema.builders.cityId, dbSchema.cities.id))
    .leftJoin(dbSchema.media, eq(dbSchema.builders.imageId, dbSchema.media.id))
    .where(
      and(
        eq(dbSchema.builders.status, 'published'),
        inArray(dbSchema.builders.moderationState, ['clean', 'reported'])
      )
    );

  return builderRows.map((row) => ({
    id: row.builder.id,
    slug: row.builder.slug,
    name: row.builder.name,
    citySlug: row.citySlug,
    role: row.builder.role,
    roles: row.builder.roles as any,
    bio: row.builder.bio || undefined,
    status: row.builder.status as 'published',
    featured: row.builder.featured,
    /**
     * A plain URL string, not a media record.
     *
     * `Builder.image` in `src/data/types.ts` is `string | undefined` — a
     * convention both `RecordSet` sources already follow, there for a
     * repository-relative asset path (`ambassadors.imagePath`,
     * `cities.imagePath`, and this same column shape on `builders`). An
     * uploaded avatar's Blob URL is structurally the same kind of value: a
     * string a template renders into an `<img>`. Returning the whole `media`
     * row here would mean `BuilderIndex.astro` — which is shared with the
     * `publicBuilders` listing — had to accept two incompatible shapes for
     * one field.
     *
     * Gated on `status === 'published'`: a `staged` upload (mid-crop, not yet
     * confirmed) has no business appearing on a public index.
     */
    image: row.media?.status === 'published' ? row.media.blobUrl ?? undefined : undefined,
  }));
}
