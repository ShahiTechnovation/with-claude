import { eq, and } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { pooledDb } from '../../db/pool';
import * as dbSchema from '../../db/schema';
import { loadRecordSet } from '../data/source-db';
import type { RecordSet } from '../data/source';

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

/**
 * The canonical public-builder predicate.
 *
 * A builder is public when:
 *   status = 'published'   — an editorial or self-publish decision
 *   moderationState = 'clean' — no moderation action is in effect
 *
 * 'reported' is NOT public. A reported builder has been flagged and is
 * awaiting moderator action; showing it as public-clean would circumvent
 * the moderation review. Any route that previously admitted 'reported' as
 * public was inconsistent with the stated moderation semantics.
 *
 * This is the only place that decides what is public for the builders
 * surface. All queries must use it or call `isPublicBuilder()` directly.
 */
export function isPublicBuilder(b: { status: string; moderationState: string }): boolean {
  return b.status === 'published' && b.moderationState === 'clean';
}

/**
 * A builder is indexable (appears in directory/search/sitemap) when:
 * 1. It is public (published + clean)
 * 2. It is NOT explicitly unlisted
 */
export function isIndexableBuilder(b: { status: string; moderationState: string; profileVisibility?: string }): boolean {
  if (!isPublicBuilder(b)) return false;
  // If visibility is unlisted, it is accessible via direct URL but not indexable
  return b.profileVisibility !== 'unlisted';
}

/**
 * The full builder row shape returned by getPublicBuilderList and
 * getPublicBuilderBySlug.
 */
export interface PublicBuilderRow {
  id: string;
  slug: string;
  name: string;
  citySlug: string;
  role: string;
  roles: string[];
  bio: string | undefined;
  status: string;
  moderationState: string;
  profileVisibility: string | undefined;
  featured: boolean;
  ownerMemberId: string | null;
  source: string;
  image: string | undefined;
}

export async function getPublicBuilderList(db: Db = pooledDb()): Promise<PublicBuilderRow[]> {
  const builderRows = await db
    .select({
      builder: dbSchema.builders,
      citySlug: dbSchema.cities.slug,
      media: dbSchema.media,
      profileVisibility: dbSchema.memberProfiles.visibility,
    })
    .from(dbSchema.builders)
    .innerJoin(dbSchema.cities, eq(dbSchema.builders.cityId, dbSchema.cities.id))
    .leftJoin(dbSchema.media, eq(dbSchema.builders.imageId, dbSchema.media.id))
    .leftJoin(dbSchema.memberProfiles, eq(dbSchema.builders.ownerMemberId, dbSchema.memberProfiles.memberId))
    .where(
      and(
        eq(dbSchema.builders.status, 'published'),
        eq(dbSchema.builders.moderationState, 'clean'),
      )
    );

  // We filter out unlisted builders after query or as part of the return map.
  return builderRows
    .filter((row) => isIndexableBuilder({
      status: row.builder.status,
      moderationState: row.builder.moderationState,
      profileVisibility: row.profileVisibility ?? undefined
    }))
    .map((row) => ({
    id: row.builder.id,
    slug: row.builder.slug,
    name: row.builder.name,
    citySlug: row.citySlug,
    role: row.builder.role,
    roles: row.builder.roles as string[],
    bio: row.builder.bio || undefined,
    status: row.builder.status,
    moderationState: row.builder.moderationState,
    profileVisibility: row.profileVisibility ?? undefined,
    featured: row.builder.featured,
    ownerMemberId: row.builder.ownerMemberId ?? null,
    source: row.builder.source,
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

/**
 * Fetch one builder by slug for the SSR detail page.
 *
 * Returns the full builder row plus resolved city slug and uploaded image URL.
 * Returns null if the builder does not exist.
 *
 * This function returns the raw row regardless of visibility state so that:
 *  - Moderators can inspect restricted/removed content (the caller filters)
 *  - The caller applies the canonical isPublicBuilder() predicate itself
 *
 * This replaces the former pattern of calling useLiveRecords() then
 * publicBuilders.find(...), which depended on a module-global build-time
 * RecordSet that never contains freshly self-published builders.
 */
export async function getPublicBuilderBySlug(
  slug: string,
  db: Db = pooledDb(),
): Promise<PublicBuilderRow | null> {
  const [row] = await db
    .select({
      builder: dbSchema.builders,
      citySlug: dbSchema.cities.slug,
      media: dbSchema.media,
      profileVisibility: dbSchema.memberProfiles.visibility,
    })
    .from(dbSchema.builders)
    .innerJoin(dbSchema.cities, eq(dbSchema.builders.cityId, dbSchema.cities.id))
    .leftJoin(dbSchema.media, eq(dbSchema.builders.imageId, dbSchema.media.id))
    .leftJoin(dbSchema.memberProfiles, eq(dbSchema.builders.ownerMemberId, dbSchema.memberProfiles.memberId))
    .where(eq(dbSchema.builders.slug, slug));

  if (!row) return null;

  return {
    id: row.builder.id,
    slug: row.builder.slug,
    name: row.builder.name,
    citySlug: row.citySlug,
    role: row.builder.role,
    roles: row.builder.roles as string[],
    bio: row.builder.bio || undefined,
    status: row.builder.status,
    moderationState: row.builder.moderationState,
    profileVisibility: row.profileVisibility ?? undefined,
    featured: row.builder.featured,
    ownerMemberId: row.builder.ownerMemberId ?? null,
    source: row.builder.source,
    image: row.media?.status === 'published' ? row.media.blobUrl ?? undefined : undefined,
  };
}



/**
 * Load a FRESH, REQUEST-LOCAL RecordSet from Neon.
 *
 * Each call returns a new, independent RecordSet scoped to the current
 * request. No module-global state is mutated. Concurrent SSR requests
 * receive isolated datasets.
 *
 * Previously this was `useLiveRecords()` which called `__setRecords()` and
 * wrote into the module-global `cached` in `dataset.ts`. That was a P0
 * request-isolation bug: two concurrent requests shared one global dataset
 * and request A's load could clobber request B's read window.
 *
 * Callers must pass the returned RecordSet explicitly to selector functions
 * instead of relying on module-scope imports from `src/data/index.ts`.
 */
export async function loadLiveRecords(db: Db = pooledDb()): Promise<RecordSet> {
  return loadRecordSet(db);
}

/**
 * Search data for the /discover page.
 *
 * Uses the canonical isPublic predicate: status = 'published' or 'featured'.
 */
export function getPublicSearchData(rs: RecordSet) {
  const isVisible = (r: { status: string }) => r.status === 'published' || r.status === 'featured';
  return {
    builders: rs.builders.filter(b => isIndexableBuilder(b as any)),
    projects: rs.projects.filter(isVisible),
    events: rs.events.filter(isVisible),
    ambassadors: rs.ambassadors.filter(isVisible),
    cities: rs.cities.filter(isVisible),
    useCases: rs.useCases.filter(isVisible),
    stories: rs.stories.filter(isVisible),
    guides: rs.guides.filter(isVisible),
  };
}
