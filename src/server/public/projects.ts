/**
 * PUBLIC PROJECT READS — bounded queries for the pages that show projects.
 *
 * These replace two patterns on the project routes:
 *
 *   · `loadLiveRecords()` on every request — every table, whole, to render one
 *     page — plus `getPublicProjects()`, which then read ALL of
 *     `project_builders`, `builders` and `cities` again to build cards.
 *   · `getProjectData()`, which fetched a project's builders one query per
 *     builder, and resolved "Built at" by looking an event UUID up in a map
 *     keyed by slug (so it never resolved).
 *
 * Every function here builds its WHERE from `publicProjectWhere()`, so the
 * list, the detail page, the homepage, event and builder pages, search and the
 * sitemap agree on what is public. The DTOs carry only public fields.
 *
 * ── COVERS ───────────────────────────────────────────────────────────────
 *
 * `image` on a DTO is either a Blob URL whose media row is `published`, or a
 * repository asset key. An http(s) `image_path` with no media row behind it
 * is dropped — see `src/server/media/covers.ts`.
 */
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import { publicProjectWhere } from '../projects/lifecycle';
import type { IsoDate } from '../../data/types';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type ProjectCategory = (typeof schema.projectCategory.enumValues)[number];

export interface PublicCredit {
  name: string;
  /** Present only when the credit resolves to a PUBLIC builder profile. */
  href?: string;
  role?: string;
}

export interface PublicProjectCard {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  category: ProjectCategory;
  city: { slug: string; name: string } | null;
  event: { slug: string; title: string; date: IsoDate } | null;
  credits: PublicCredit[];
  image?: string;
  tags: string[];
  featured: boolean;
  /** Imported from an event archive and not yet claimed by a member. */
  imported: boolean;
}

export interface PublicProjectDetail extends PublicProjectCard {
  description: string | null;
  claudeUsage: string | null;
  url: string | null;
  repoUrl: string | null;
  videoUrl: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  contentAuthority: (typeof schema.contentAuthority.enumValues)[number];
  /** Raw states, for the moderator banner. Never rendered to the public. */
  publicationStatus: string;
  moderationState: string;
  isPublic: boolean;
  useCases: { slug: string; title: string }[];
}

// ── shared pieces ────────────────────────────────────────────────────────

const cardColumns = {
  id: schema.projects.id,
  slug: schema.projects.slug,
  title: schema.projects.title,
  summary: schema.projects.summary,
  category: schema.projects.category,
  tags: schema.projects.tags,
  featured: schema.projects.featured,
  imagePath: schema.projects.imagePath,
  contentAuthority: schema.projects.contentAuthority,
  ownerMemberId: schema.projects.ownerMemberId,
  citySlug: schema.cities.slug,
  cityName: schema.cities.name,
  eventSlug: schema.events.slug,
  eventTitle: schema.events.title,
  eventDate: schema.events.date,
  mediaUrl: schema.media.blobUrl,
  mediaStatus: schema.media.status,
};

type CardRow = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  category: ProjectCategory;
  tags: string[];
  featured: boolean;
  imagePath: string | null;
  contentAuthority: (typeof schema.contentAuthority.enumValues)[number];
  ownerMemberId: string | null;
  citySlug: string | null;
  cityName: string | null;
  eventSlug: string | null;
  eventTitle: string | null;
  eventDate: string | null;
  mediaUrl: string | null;
  mediaStatus: string | null;
};

/**
 * The cover a public page may render.
 *
 *   media-backed  only when the media row is `published`
 *   asset key     a repository path (no scheme), resolved by `asset()` later
 *   anything else nothing — never an arbitrary URL from a request body
 */
export function publicCover(row: {
  imagePath: string | null;
  mediaUrl: string | null;
  mediaStatus: string | null;
}): string | undefined {
  if (row.mediaUrl) return row.mediaStatus === 'published' ? row.mediaUrl : undefined;
  if (row.imagePath && !/^[a-z][a-z0-9+.-]*:/i.test(row.imagePath)) return row.imagePath;
  return undefined;
}

/** An event row is linked only when the event itself is public. */
const publicEventJoin = and(
  eq(schema.events.id, schema.projects.builtAtEventId),
  eq(schema.events.status, 'published'),
);
const publicCityJoin = and(
  eq(schema.cities.id, schema.projects.cityId),
  eq(schema.cities.status, 'published'),
);

function toCard(row: CardRow, credits: PublicCredit[]): PublicProjectCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    category: row.category,
    tags: row.tags ?? [],
    featured: row.featured,
    city: row.citySlug ? { slug: row.citySlug, name: row.cityName ?? row.citySlug } : null,
    event:
      row.eventSlug && row.eventTitle && row.eventDate
        ? { slug: row.eventSlug, title: row.eventTitle, date: String(row.eventDate).slice(0, 10) as IsoDate }
        : null,
    credits,
    image: publicCover(row),
    imported: row.contentAuthority === 'baserow',
  };
}

/**
 * Credits for a batch of projects, in ONE query per source.
 *
 * Builders: a credit is shown by name; it links only when the builder profile
 * is itself public. An archived or moderator-held builder is not credited at
 * all — a takedown whose subject keeps appearing in credits is not a takedown.
 * A `pending` builder (the curated archive's Impact Lab cohort) is credited
 * by name without a link, exactly as the static archive does.
 *
 * Imported credits (`project_credits`) are display names from an organiser's
 * record. They never create an account and never link unless a verified
 * builder association was made application-side.
 */
export async function creditsFor(
  db: AnyDatabase,
  projectIds: string[],
): Promise<Map<string, PublicCredit[]>> {
  const out = new Map<string, PublicCredit[]>();
  if (projectIds.length === 0) return out;

  const builderRows = await db
    .select({
      projectId: schema.projectBuilders.projectId,
      position: schema.projectBuilders.position,
      slug: schema.builders.slug,
      name: schema.builders.name,
      status: schema.builders.status,
      moderationState: schema.builders.moderationState,
      visibility: schema.memberProfiles.visibility,
    })
    .from(schema.projectBuilders)
    .innerJoin(schema.builders, eq(schema.builders.id, schema.projectBuilders.builderId))
    .leftJoin(schema.memberProfiles, eq(schema.memberProfiles.memberId, schema.builders.ownerMemberId))
    .where(
      and(
        inArray(schema.projectBuilders.projectId, projectIds),
        ne(schema.builders.status, 'archived'),
        inArray(schema.builders.moderationState, ['clean', 'reported']),
        isNull(schema.builders.deletedAt),
      ),
    )
    .orderBy(asc(schema.projectBuilders.position), asc(schema.builders.name));

  for (const row of builderRows) {
    // Unlisted means direct-link only: credited by name, never promoted by a link.
    const linkable =
      row.status === 'published' && row.moderationState === 'clean' && row.visibility !== 'unlisted';
    const list = out.get(row.projectId) ?? [];
    list.push({ name: row.name, ...(linkable ? { href: `/builders/${row.slug}/` } : {}) });
    out.set(row.projectId, list);
  }

  const imported = await importedCreditsFor(db, projectIds);
  for (const [projectId, credits] of imported) {
    const list = out.get(projectId) ?? [];
    const seen = new Set(list.map((c) => c.name.toLowerCase()));
    for (const credit of credits) {
      if (!seen.has(credit.name.toLowerCase())) list.push(credit);
    }
    out.set(projectId, list);
  }
  return out;
}

/** Organiser-recorded team credits. Display names, never accounts. */
async function importedCreditsFor(
  db: AnyDatabase,
  projectIds: string[],
): Promise<Map<string, PublicCredit[]>> {
  const out = new Map<string, PublicCredit[]>();
  const credits = schema.projectCredits;
  const rows = await db
    .select({
      projectId: credits.projectId,
      name: credits.displayName,
      role: credits.role,
      builderSlug: schema.builders.slug,
      builderStatus: schema.builders.status,
      builderModeration: schema.builders.moderationState,
    })
    .from(credits)
    .leftJoin(schema.builders, eq(schema.builders.id, credits.builderId))
    .where(inArray(credits.projectId, projectIds))
    .orderBy(asc(credits.position), asc(credits.displayName));
  for (const row of rows) {
    const linkable =
      row.builderSlug && row.builderStatus === 'published' && row.builderModeration === 'clean';
    const list = out.get(row.projectId) ?? [];
    list.push({
      name: row.name,
      ...(row.role ? { role: row.role } : {}),
      ...(linkable ? { href: `/builders/${row.builderSlug}/` } : {}),
    });
    out.set(row.projectId, list);
  }
  return out;
}

// ── the archive listing ─────────────────────────────────────────────────

export type ProjectSort = 'featured' | 'newest';

export interface ProjectQuery {
  q?: string;
  category?: string;
  city?: string;
  event?: string;
  sort?: ProjectSort;
  page?: number;
  pageSize?: number;
}

export interface ProjectFacet {
  value: string;
  label: string;
  count: number;
}

export interface ProjectListResult {
  items: PublicProjectCard[];
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  query: Required<Pick<ProjectQuery, 'sort'>> & Omit<ProjectQuery, 'sort' | 'page' | 'pageSize'>;
  facets: { categories: ProjectFacet[]; cities: ProjectFacet[]; events: ProjectFacet[] };
}

const CATEGORY_VALUES = new Set<string>(schema.projectCategory.enumValues);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Normalise untrusted query-string input. Unknown values are dropped rather
 * than rejected, so a stale shared link degrades to a wider result instead of
 * an error page.
 */
export function normaliseProjectQuery(params: URLSearchParams): ProjectQuery {
  const q = (params.get('q') ?? '').trim().slice(0, 80);
  const category = params.get('category') ?? '';
  const city = params.get('city') ?? '';
  const event = params.get('event') ?? '';
  const sort = params.get('sort') === 'newest' ? 'newest' : 'featured';
  const page = Math.max(1, Math.min(500, Number.parseInt(params.get('page') ?? '1', 10) || 1));
  return {
    ...(q ? { q } : {}),
    ...(CATEGORY_VALUES.has(category) ? { category } : {}),
    ...(SLUG_RE.test(city) ? { city } : {}),
    ...(SLUG_RE.test(event) ? { event } : {}),
    sort,
    page,
  };
}

/** `%` and `_` are wildcards in LIKE; a visitor's text is matched literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function filterWhere(query: ProjectQuery): SQL {
  const parts: SQL[] = [publicProjectWhere()];
  if (query.category) parts.push(eq(schema.projects.category, query.category as ProjectCategory));
  if (query.city) parts.push(eq(schema.cities.slug, query.city));
  if (query.event) parts.push(eq(schema.events.slug, query.event));
  if (query.q) {
    const pattern = likePattern(query.q);
    parts.push(
      or(
        ilike(schema.projects.title, pattern),
        ilike(schema.projects.summary, pattern),
        sql`array_to_string(${schema.projects.tags}, ' ') ILIKE ${pattern}`,
      )!,
    );
  }
  return and(...parts)!;
}

/**
 * ORDERING, DEFINED.
 *
 *   featured  featured first (by `featured_order`), then the curated archive's
 *             authored `position`, then newest
 *   newest    `published_at` (first time it went public, or import time), then
 *             the date of the event it was built at — a real, evidenced date,
 *             never an invented build date — then slug
 *
 * Slug is the final tie-breaker in both, so pagination is stable.
 */
function orderFor(sort: ProjectSort): SQL[] {
  const newest = [
    sql`${schema.projects.publishedAt} DESC NULLS LAST`,
    sql`${schema.events.date} DESC NULLS LAST`,
    asc(schema.projects.slug),
  ];
  if (sort === 'newest') return newest;
  return [
    desc(schema.projects.featured),
    sql`${schema.projects.featuredOrder} ASC NULLS LAST`,
    sql`${schema.projects.position} ASC NULLS LAST`,
    ...newest,
  ];
}

export const DEFAULT_PAGE_SIZE = 24;

export async function listPublicProjects(
  db: AnyDatabase,
  input: ProjectQuery = {},
): Promise<ProjectListResult> {
  const pageSize = Math.max(1, Math.min(60, input.pageSize ?? DEFAULT_PAGE_SIZE));
  const sort = input.sort ?? 'featured';
  const where = filterWhere(input);

  const base = () =>
    db
      .select(cardColumns)
      .from(schema.projects)
      .leftJoin(schema.cities, publicCityJoin)
      .leftJoin(schema.events, publicEventJoin)
      .leftJoin(schema.media, eq(schema.media.id, schema.projects.imageId));

  const [[{ total }], facets] = await Promise.all([
    db
      .select({ total: count() })
      .from(schema.projects)
      .leftJoin(schema.cities, publicCityJoin)
      .leftJoin(schema.events, publicEventJoin)
      .where(where),
    projectFacets(db),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(input.page ?? 1, pageCount);

  const rows = (await base()
    .where(where)
    .orderBy(...orderFor(sort))
    .limit(pageSize)
    .offset((page - 1) * pageSize)) as CardRow[];

  const credits = await creditsFor(
    db,
    rows.map((r) => r.id),
  );

  const { page: _p, pageSize: _ps, sort: _s, ...filters } = input;
  return {
    items: rows.map((row) => toCard(row, credits.get(row.id) ?? [])),
    total,
    page,
    pageCount,
    pageSize,
    query: { ...filters, sort },
    facets,
  };
}

/**
 * Filter options, built from what is actually public, so an option never
 * promises results that are not there.
 */
export async function projectFacets(db: AnyDatabase): Promise<ProjectListResult['facets']> {
  const pub = publicProjectWhere();
  const [categories, cities, events] = await Promise.all([
    db
      .select({ value: schema.projects.category, count: count() })
      .from(schema.projects)
      .where(pub)
      .groupBy(schema.projects.category),
    db
      .select({ value: schema.cities.slug, label: schema.cities.name, count: count() })
      .from(schema.projects)
      .innerJoin(schema.cities, publicCityJoin)
      .where(pub)
      .groupBy(schema.cities.slug, schema.cities.name),
    db
      .select({
        value: schema.events.slug,
        label: schema.events.title,
        date: schema.events.date,
        count: count(),
      })
      .from(schema.projects)
      .innerJoin(schema.events, publicEventJoin)
      .where(pub)
      .groupBy(schema.events.slug, schema.events.title, schema.events.date),
  ]);

  return {
    categories: categories
      .map((c) => ({ value: c.value, label: c.value, count: c.count }))
      .sort((a, b) => a.value.localeCompare(b.value)),
    cities: cities
      .map((c) => ({ value: c.value, label: c.label, count: c.count }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    events: events
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .map((e) => ({ value: e.value, label: e.label, count: e.count })),
  };
}

/** Projects built at one event, for the event page. Same predicate. */
export async function publicProjectsForEvent(
  db: AnyDatabase,
  eventId: string,
  limit = 60,
): Promise<PublicProjectCard[]> {
  const rows = (await db
    .select(cardColumns)
    .from(schema.projects)
    .leftJoin(schema.cities, publicCityJoin)
    .leftJoin(schema.events, publicEventJoin)
    .leftJoin(schema.media, eq(schema.media.id, schema.projects.imageId))
    .where(and(publicProjectWhere(), eq(schema.projects.builtAtEventId, eventId)))
    .orderBy(...orderFor('featured'))
    .limit(limit)) as CardRow[];
  const credits = await creditsFor(db, rows.map((r) => r.id));
  return rows.map((row) => toCard(row, credits.get(row.id) ?? []));
}

/** Public projects credited to a builder (by credit or by ownership). */
export async function publicProjectsForBuilder(
  db: AnyDatabase,
  builder: { id: string; ownerMemberId: string | null },
  limit = 60,
): Promise<PublicProjectCard[]> {
  const credited = sql`${schema.projects.id} IN (SELECT project_id FROM project_builders WHERE builder_id = ${builder.id})`;
  const owned = builder.ownerMemberId
    ? eq(schema.projects.ownerMemberId, builder.ownerMemberId)
    : undefined;
  const rows = (await db
    .select(cardColumns)
    .from(schema.projects)
    .leftJoin(schema.cities, publicCityJoin)
    .leftJoin(schema.events, publicEventJoin)
    .leftJoin(schema.media, eq(schema.media.id, schema.projects.imageId))
    .where(and(publicProjectWhere(), owned ? or(credited, owned) : credited))
    .orderBy(...orderFor('newest'))
    .limit(limit)) as CardRow[];
  const credits = await creditsFor(db, rows.map((r) => r.id));
  return rows.map((row) => toCard(row, credits.get(row.id) ?? []));
}

/** The homepage's featured/recent strip. */
export async function featuredPublicProjects(
  db: AnyDatabase,
  limit = 6,
): Promise<PublicProjectCard[]> {
  const result = await listPublicProjects(db, { sort: 'featured', pageSize: limit });
  return result.items;
}

// ── one project ─────────────────────────────────────────────────────────

/**
 * One project by slug, REGARDLESS of visibility — the caller decides, using
 * `isPublic`, whether to render it, 404 it, or show a moderator banner with
 * a private response. Four bounded queries in total.
 */
export async function getProjectDetail(
  db: AnyDatabase,
  slug: string,
): Promise<PublicProjectDetail | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)) return null;

  const [row] = await db
    .select({
      ...cardColumns,
      description: schema.projects.description,
      claudeUsage: schema.projects.claudeUsage,
      url: schema.projects.url,
      repoUrl: schema.projects.repoUrl,
      videoUrl: schema.projects.videoUrl,
      publishedAt: schema.projects.publishedAt,
      updatedAt: schema.projects.updatedAt,
      publicationStatus: schema.projects.publicationStatus,
      moderationState: schema.projects.moderationState,
      deletedAt: schema.projects.deletedAt,
      builtAtEventId: schema.projects.builtAtEventId,
    })
    .from(schema.projects)
    .leftJoin(schema.cities, publicCityJoin)
    .leftJoin(schema.events, publicEventJoin)
    .leftJoin(schema.media, eq(schema.media.id, schema.projects.imageId))
    .where(eq(schema.projects.slug, slug));

  if (!row) return null;

  const [credits, useCases] = await Promise.all([
    creditsFor(db, [row.id]),
    db
      .select({ slug: schema.useCases.slug, title: schema.useCases.title })
      .from(schema.useCases)
      .where(and(eq(schema.useCases.projectId, row.id), eq(schema.useCases.status, 'published'))),
  ]);

  const isPublic =
    row.publicationStatus === 'published' && row.moderationState === 'clean' && !row.deletedAt;

  return {
    ...toCard(row as CardRow, credits.get(row.id) ?? []),
    description: row.description,
    claudeUsage: row.claudeUsage,
    url: row.url,
    repoUrl: row.repoUrl,
    videoUrl: row.videoUrl,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    contentAuthority: row.contentAuthority,
    publicationStatus: row.publicationStatus,
    moderationState: row.moderationState,
    isPublic,
    useCases,
  };
}

/**
 * Related public projects: same event first, then same city, never itself.
 */
export async function relatedPublicProjects(
  db: AnyDatabase,
  project: { id: string; event: { slug: string } | null; city: { slug: string } | null },
  limit = 3,
): Promise<PublicProjectCard[]> {
  if (!project.event && !project.city) return [];
  const sameEvent = project.event ? sql`(${schema.events.slug} = ${project.event.slug})` : sql`false`;
  const sameCity = project.city ? sql`(${schema.cities.slug} = ${project.city.slug})` : sql`false`;
  const rows = (await db
    .select(cardColumns)
    .from(schema.projects)
    .leftJoin(schema.cities, publicCityJoin)
    .leftJoin(schema.events, publicEventJoin)
    .leftJoin(schema.media, eq(schema.media.id, schema.projects.imageId))
    .where(and(publicProjectWhere(), ne(schema.projects.id, project.id), or(sameEvent, sameCity)))
    // Same-event first only when there IS an event: a bare `false` is not a
    // valid ORDER BY term in PostgreSQL ("non-integer constant in ORDER BY").
    .orderBy(...(project.event ? [sql`${sameEvent} DESC NULLS LAST`] : []), ...orderFor('featured'))
    .limit(limit)) as CardRow[];
  const credits = await creditsFor(db, rows.map((r) => r.id));
  return rows.map((row) => toCard(row, credits.get(row.id) ?? []));
}
