/**
 * PUBLIC PROJECT READS — the one data layer behind every page that shows a
 * project: the Project Directory, a project page, an event page, a builder
 * page, the homepage and the claim page.
 *
 * Every query builds its WHERE from `publicProjectWhere()`, so a list, a
 * count, a facet and a detail page can never disagree about what is public —
 * and hidden or draft records cannot leak through a count.
 *
 * ── ONE DTO ──────────────────────────────────────────────────────────────
 *
 * `PublicProjectCard.event` carries the event's UUID, slug, title, short
 * label, the date it was ACTUALLY held, and its city — resolved by joining on
 * the project's `built_at_event_id`, never by a slug map, and never as
 * hand-written text on a card. Correcting an event (the Impact Lab that moved
 * from 13 to 15 September) therefore corrects every badge, filter, detail
 * page, related list, search result and piece of structured data at once.
 *
 * ── COVERS AND LOGOS ─────────────────────────────────────────────────────
 *
 * `image` is the cover/screenshot; `logo` is what the square logo box shows,
 * chosen by `resolveLogoSource()` (see `src/lib/project-logo.ts`). Both are
 * either a published Blob URL or a repository asset key — never an arbitrary
 * URL, and never something fetched while a page renders.
 */
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import { publicProjectWhere } from '../projects/lifecycle';
import { resolveLogoSource, type LogoSource } from '../../lib/project-logo';
import type { IsoDate } from '../../data/types';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export type ProjectCategory = (typeof schema.projectCategory.enumValues)[number];
export type BuildStatus = (typeof schema.projectBuildStatus.enumValues)[number];

export interface PublicCredit {
  name: string;
  /** Present only when the credit resolves to a PUBLIC builder profile. */
  href?: string;
  role?: string;
}

/** The event a project was built at — identical on every surface. */
export interface PublicEventRef {
  id: string;
  slug: string;
  title: string;
  /** The full name without a feed's "City | " prefix — the city is shown separately. */
  name: string;
  /** Badge label: the editorial short title, or `name`. */
  label: string;
  /** The day it was actually held. */
  date: IsoDate;
  /** The originally announced date, when it moved. Display-only. */
  rescheduledFrom: IsoDate | null;
  city: { slug: string; name: string } | null;
}

export interface PublicProjectLinks {
  live: string | null;
  repo: string | null;
  video: string | null;
  download: string | null;
}

export interface PublicProjectCard {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  category: ProjectCategory;
  /** The project's own city (a member project's home). NOT the event city. */
  city: { slug: string; name: string } | null;
  event: PublicEventRef | null;
  /** The team label, if one is published. */
  team: string | null;
  /** People credits (never the team label). */
  credits: PublicCredit[];
  /** Cover/screenshot. */
  image?: string;
  logo: LogoSource;
  tags: string[];
  featured: boolean;
  buildStatus: BuildStatus | null;
  links: PublicProjectLinks;
  /** Imported from an event archive and not yet claimed by a member. */
  imported: boolean;
}

export interface PublicProjectDetail extends PublicProjectCard {
  description: string | null;
  claudeUsage: string | null;
  problem: string | null;
  solution: string | null;
  builtWith: string | null;
  url: string | null;
  repoUrl: string | null;
  videoUrl: string | null;
  altVideoUrl: string | null;
  downloadUrl: string | null;
  artifactUrl: string | null;
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

/** The project's own city. */
const projectCity = alias(schema.cities, 'project_city');
/** The city the event was held in — the directory's "Event city". */
const eventCity = alias(schema.cities, 'event_city');
const cover = alias(schema.media, 'cover_media');
const logoMedia = alias(schema.media, 'logo_media');

const cardColumns = {
  id: schema.projects.id,
  slug: schema.projects.slug,
  title: schema.projects.title,
  summary: schema.projects.summary,
  category: schema.projects.category,
  tags: schema.projects.tags,
  featured: schema.projects.featured,
  imagePath: schema.projects.imagePath,
  logoPath: schema.projects.logoPath,
  contentAuthority: schema.projects.contentAuthority,
  ownerMemberId: schema.projects.ownerMemberId,
  buildStatus: schema.projects.buildStatus,
  url: schema.projects.url,
  repoUrl: schema.projects.repoUrl,
  videoUrl: schema.projects.videoUrl,
  downloadUrl: schema.projects.downloadUrl,
  citySlug: projectCity.slug,
  cityName: projectCity.name,
  eventId: schema.events.id,
  eventSlug: schema.events.slug,
  eventTitle: schema.events.title,
  eventShortTitle: schema.events.shortTitle,
  eventDate: schema.events.date,
  eventRescheduledFrom: schema.events.rescheduledFrom,
  eventCitySlug: eventCity.slug,
  eventCityName: eventCity.name,
  mediaUrl: cover.blobUrl,
  mediaStatus: cover.status,
  logoUrl: logoMedia.blobUrl,
  logoStatus: logoMedia.status,
  logoProvenance: logoMedia.provenance,
  logoWidth: logoMedia.width,
  logoHeight: logoMedia.height,
};

type CardRow = Awaited<ReturnType<typeof selectCards>>[number];

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
const publicProjectCityJoin = and(eq(projectCity.id, schema.projects.cityId), eq(projectCity.status, 'published'));
const publicEventCityJoin = and(eq(eventCity.id, schema.events.cityId), eq(eventCity.status, 'published'));

/** Feed titles arrive as "Bhopal | Claude Code Build Day - Fable 5.1"; the city renders separately. */
export function eventLabel(title: string, shortTitle: string | null): string {
  if (shortTitle?.trim()) return shortTitle.trim();
  return title.replace(/^[^|]{2,40}\|\s*/, '').trim() || title;
}

function selectCards(db: AnyDatabase) {
  return db
    .select(cardColumns)
    .from(schema.projects)
    .leftJoin(projectCity, publicProjectCityJoin)
    .leftJoin(schema.events, publicEventJoin)
    .leftJoin(eventCity, publicEventCityJoin)
    .leftJoin(cover, eq(cover.id, schema.projects.imageId))
    .leftJoin(logoMedia, eq(logoMedia.id, schema.projects.logoMediaId));
}

function toEventRef(row: CardRow): PublicEventRef | null {
  if (!row.eventId || !row.eventSlug || !row.eventTitle || !row.eventDate) return null;
  return {
    id: row.eventId,
    slug: row.eventSlug,
    title: row.eventTitle,
    name: eventLabel(row.eventTitle, null),
    label: eventLabel(row.eventTitle, row.eventShortTitle),
    date: String(row.eventDate).slice(0, 10) as IsoDate,
    rescheduledFrom: row.eventRescheduledFrom ? (String(row.eventRescheduledFrom).slice(0, 10) as IsoDate) : null,
    city: row.eventCitySlug ? { slug: row.eventCitySlug, name: row.eventCityName ?? row.eventCitySlug } : null,
  };
}

function toCard(row: CardRow, credits: { team: string | null; people: PublicCredit[] }): PublicProjectCard {
  const image = publicCover(row);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    category: row.category,
    tags: row.tags ?? [],
    featured: row.featured,
    city: row.citySlug ? { slug: row.citySlug, name: row.cityName ?? row.citySlug } : null,
    event: toEventRef(row),
    team: credits.team,
    credits: credits.people,
    image,
    logo: resolveLogoSource({
      slug: row.slug,
      logoPath: row.logoPath,
      logoMedia:
        row.logoUrl && row.logoStatus === 'published'
          ? { url: row.logoUrl, provenance: row.logoProvenance, width: row.logoWidth, height: row.logoHeight }
          : null,
      cover: image ?? null,
    }),
    buildStatus: row.buildStatus,
    links: { live: row.url, repo: row.repoUrl, video: row.videoUrl, download: row.downloadUrl },
    imported: row.contentAuthority === 'baserow',
  };
}

const TEAM_ROLE = 'Team';

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
 * builder association was made application-side. The organiser's TEAM label
 * is one of these (role "Team"); it is returned separately as `team`.
 */
export async function creditsFor(
  db: AnyDatabase,
  projectIds: string[],
): Promise<Map<string, { team: string | null; people: PublicCredit[] }>> {
  const out = new Map<string, { team: string | null; people: PublicCredit[] }>();
  const entry = (id: string) => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { team: null, people: [] }));
    return e;
  };
  if (projectIds.length === 0) return out;

  const [builderRows, importedRows] = await Promise.all([
    db
      .select({
        projectId: schema.projectBuilders.projectId,
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
      .orderBy(asc(schema.projectBuilders.position), asc(schema.builders.name)),
    db
      .select({
        projectId: schema.projectCredits.projectId,
        name: schema.projectCredits.displayName,
        role: schema.projectCredits.role,
        builderSlug: schema.builders.slug,
        builderStatus: schema.builders.status,
        builderModeration: schema.builders.moderationState,
      })
      .from(schema.projectCredits)
      .leftJoin(schema.builders, eq(schema.builders.id, schema.projectCredits.builderId))
      .where(inArray(schema.projectCredits.projectId, projectIds))
      .orderBy(asc(schema.projectCredits.position), asc(schema.projectCredits.displayName)),
  ]);

  for (const row of builderRows) {
    // Unlisted means direct-link only: credited by name, never promoted by a link.
    const linkable = row.status === 'published' && row.moderationState === 'clean' && row.visibility !== 'unlisted';
    entry(row.projectId).people.push({ name: row.name, ...(linkable ? { href: `/builders/${row.slug}/` } : {}) });
  }
  for (const row of importedRows) {
    const e = entry(row.projectId);
    if (row.role === TEAM_ROLE && !row.builderSlug) {
      e.team ??= row.name;
      continue;
    }
    if (e.people.some((c) => c.name.toLowerCase() === row.name.toLowerCase())) continue;
    const linkable = row.builderSlug && row.builderStatus === 'published' && row.builderModeration === 'clean';
    e.people.push({
      name: row.name,
      ...(row.role ? { role: row.role } : {}),
      ...(linkable ? { href: `/builders/${row.builderSlug}/` } : {}),
    });
  }
  return out;
}

const NO_CREDITS = { team: null, people: [] as PublicCredit[] };

async function cards(db: AnyDatabase, rows: CardRow[]): Promise<PublicProjectCard[]> {
  const credits = await creditsFor(db, rows.map((r) => r.id));
  return rows.map((row) => toCard(row, credits.get(row.id) ?? NO_CREDITS));
}

// ── the directory ────────────────────────────────────────────────────────

/**
 * SORTS, DEFINED.
 *
 *   event     the date the event was HELD, newest first. Projects with no
 *             public event ("independent") come after every dated one. Within
 *             an event, title A–Z. This is the default: an archive is read by
 *             event, and importing old projects today must not make them look
 *             new.
 *   recent    `published_at` — when the project first went public on this
 *             site (for an imported archive entry, when it was imported).
 *   name      title A–Z, case-insensitively.
 *   featured  an editor's `featured` flag, then its order — offered only when
 *             at least one public project is actually featured.
 *
 * Every sort ends with the slug, which is unique, so pages never overlap.
 */
export type DirectorySort = 'event' | 'recent' | 'name' | 'featured';
export const DIRECTORY_SORTS: DirectorySort[] = ['event', 'recent', 'name', 'featured'];

export type LinkRequirement = 'live' | 'repo' | 'video';
export const LINK_REQUIREMENTS: LinkRequirement[] = ['live', 'repo', 'video'];

/** The "no event" option in the event filter. Not a valid event slug (events never use it). */
export const INDEPENDENT = 'independent';

export interface DirectoryQuery {
  q?: string;
  /** Event slugs (OR), or `independent`. Empty means all events. */
  events: string[];
  categories: ProjectCategory[];
  /** Event-city slugs (OR). */
  cities: string[];
  statuses: BuildStatus[];
  /** Each is a requirement (AND). */
  has: LinkRequirement[];
  sort: DirectorySort;
  page: number;
  pageSize?: number;
}

export interface Facet {
  value: string;
  label: string;
  count: number;
  /** For events: the held date, for the option label. */
  date?: IsoDate;
}

export interface ProjectListResult {
  items: PublicProjectCard[];
  /** Matches for the current filters. */
  total: number;
  /** Every public project, regardless of filters. */
  totalPublic: number;
  page: number;
  pageCount: number;
  pageSize: number;
  query: DirectoryQuery;
  facets: {
    events: Facet[];
    categories: Facet[];
    cities: Facet[];
    statuses: Facet[];
    has: Facet[];
  };
  /** Whether "Featured" is a meaningful sort right now. */
  featuredAvailable: boolean;
}

const CATEGORY_VALUES = new Set<string>(schema.projectCategory.enumValues);
const STATUS_VALUES = new Set<string>(schema.projectBuildStatus.enumValues);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const MAX_VALUES = 12;

function many(params: URLSearchParams, name: string, accept: (v: string) => boolean): string[] {
  const values = params
    .getAll(name)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v && accept(v));
  return [...new Set(values)].slice(0, MAX_VALUES);
}

/**
 * Normalise untrusted query-string input. Unknown values are dropped rather
 * than rejected, so a stale shared link degrades to a wider result instead of
 * an error page. Repeated keys (`?event=a&event=b`) and comma lists are both
 * accepted; links the site writes use repeated keys.
 */
export function normaliseDirectoryQuery(params: URLSearchParams): DirectoryQuery {
  const q = (params.get('q') ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const rawSort = params.get('sort') ?? '';
  // `newest` was the previous name of `recent`; old links keep working.
  const sort: DirectorySort = rawSort === 'newest' ? 'recent' : (DIRECTORY_SORTS as string[]).includes(rawSort) ? (rawSort as DirectorySort) : 'event';
  const page = Math.max(1, Math.min(500, Number.parseInt(params.get('page') ?? '1', 10) || 1));
  return {
    ...(q ? { q } : {}),
    events: many(params, 'event', (v) => SLUG_RE.test(v)),
    categories: many(params, 'category', (v) => CATEGORY_VALUES.has(v)) as ProjectCategory[],
    cities: many(params, 'city', (v) => SLUG_RE.test(v)),
    statuses: many(params, 'status', (v) => STATUS_VALUES.has(v)) as BuildStatus[],
    has: many(params, 'has', (v) => (LINK_REQUIREMENTS as string[]).includes(v)) as LinkRequirement[],
    sort,
    page,
  };
}

/** The canonical URL for a directory view. `page` 1 and the default sort are omitted. */
export function directoryHref(query: Partial<DirectoryQuery>, base = '/projects/'): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  for (const v of query.events ?? []) params.append('event', v);
  for (const v of query.categories ?? []) params.append('category', v);
  for (const v of query.cities ?? []) params.append('city', v);
  for (const v of query.statuses ?? []) params.append('status', v);
  for (const v of query.has ?? []) params.append('has', v);
  if (query.sort && query.sort !== 'event') params.set('sort', query.sort);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  const qs = params.toString();
  return `${base}${qs ? `?${qs}` : ''}`;
}

/** `%` and `_` are wildcards in LIKE; a visitor's text is matched literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const HAS_COLUMN: Record<LinkRequirement, SQL> = {
  live: sql`${schema.projects.url} IS NOT NULL`,
  repo: sql`${schema.projects.repoUrl} IS NOT NULL`,
  video: sql`${schema.projects.videoUrl} IS NOT NULL`,
};

type Group = 'q' | 'events' | 'categories' | 'cities' | 'statuses' | 'has';

/**
 * FILTER SEMANTICS.
 *
 *   OR within a group   event A or event B; category X or Y; city; status
 *   AND across groups   (events) AND (categories) AND (cities) AND …
 *   AND within `has`    each link switch is a requirement
 *   search              every word must appear in the title, summary, team
 *                       label or event name (any of them, per word)
 *
 * `except` drops one group — that is how a facet counts "what you would get
 * if you picked this option instead", while every OTHER active group still
 * applies.
 */
function filterWhere(query: DirectoryQuery, except?: Group): SQL {
  const parts: SQL[] = [publicProjectWhere()];
  if (except !== 'events' && query.events.length) {
    const slugs = query.events.filter((e) => e !== INDEPENDENT);
    const alternatives: SQL[] = [];
    if (slugs.length) alternatives.push(inArray(schema.events.slug, slugs));
    if (query.events.includes(INDEPENDENT)) alternatives.push(isNull(schema.events.id));
    parts.push(or(...alternatives)!);
  }
  if (except !== 'categories' && query.categories.length) parts.push(inArray(schema.projects.category, query.categories));
  if (except !== 'cities' && query.cities.length) parts.push(inArray(eventCity.slug, query.cities));
  if (except !== 'statuses' && query.statuses.length) parts.push(inArray(schema.projects.buildStatus, query.statuses));
  if (except !== 'has') for (const h of query.has) parts.push(HAS_COLUMN[h]);
  if (except !== 'q' && query.q) {
    for (const word of query.q.split(' ').filter(Boolean).slice(0, 6)) {
      const pattern = likePattern(word);
      parts.push(
        or(
          ilike(schema.projects.title, pattern),
          ilike(schema.projects.summary, pattern),
          sql`array_to_string(${schema.projects.tags}, ' ') ILIKE ${pattern}`,
          ilike(schema.events.title, pattern),
          ilike(schema.events.shortTitle, pattern),
          sql`EXISTS (SELECT 1 FROM ${schema.projectCredits} pc WHERE pc.project_id = ${schema.projects.id} AND pc.role = ${TEAM_ROLE} AND pc.display_name ILIKE ${pattern})`,
        )!,
      );
    }
  }
  return and(...parts)!;
}

function orderFor(sort: DirectorySort): SQL[] {
  // Byte order on the lower-cased title: the same result on every database
  // (a locale collation sorts punctuation differently on Windows, glibc and
  // ICU), and the classic word-by-word order — "Bhopal Tourism" before
  // "BhopalFlow".
  const byName = [sql`lower(${schema.projects.title}) COLLATE "C" ASC`, asc(schema.projects.slug)];
  const byEvent = [sql`${schema.events.date} DESC NULLS LAST`, ...byName];
  switch (sort) {
    case 'name':
      return byName;
    case 'recent':
      return [sql`${schema.projects.publishedAt} DESC NULLS LAST`, ...byEvent];
    case 'featured':
      return [
        desc(schema.projects.featured),
        sql`${schema.projects.featuredOrder} ASC NULLS LAST`,
        sql`${schema.projects.position} ASC NULLS LAST`,
        ...byEvent,
      ];
    default:
      return byEvent;
  }
}

/** The joins every count and facet needs (no media: counts never read covers). */
function countFrom(db: AnyDatabase, columns: Record<string, unknown>) {
  return db
    .select(columns as never)
    .from(schema.projects)
    .leftJoin(schema.events, publicEventJoin)
    .leftJoin(eventCity, publicEventCityJoin);
}

export const DEFAULT_PAGE_SIZE = 20;

export async function listPublicProjects(
  db: AnyDatabase,
  input: Partial<DirectoryQuery> = {},
): Promise<ProjectListResult> {
  const query: DirectoryQuery = {
    events: [],
    categories: [],
    cities: [],
    statuses: [],
    has: [],
    sort: 'event',
    page: 1,
    ...input,
  };
  const pageSize = Math.max(1, Math.min(60, query.pageSize ?? DEFAULT_PAGE_SIZE));
  const where = filterWhere(query);

  const [[{ total }], [{ totalPublic, featuredCount }], facets] = await Promise.all([
    countFrom(db, { total: count() }).where(where) as unknown as Promise<{ total: number }[]>,
    db
      .select({
        totalPublic: count(),
        featuredCount: sql<number>`count(*) FILTER (WHERE ${schema.projects.featured})`.mapWith(Number),
      })
      .from(schema.projects)
      .where(publicProjectWhere()),
    directoryFacets(db, query),
  ]);

  const sort = query.sort === 'featured' && featuredCount === 0 ? 'event' : query.sort;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(query.page, pageCount);
  const rows = (await selectCards(db)
    .where(where)
    .orderBy(...orderFor(sort))
    .limit(pageSize)
    .offset((page - 1) * pageSize)) as CardRow[];

  return {
    items: await cards(db, rows),
    total,
    totalPublic,
    page,
    pageCount,
    pageSize,
    query: { ...query, sort, page },
    facets,
    featuredAvailable: featuredCount > 0,
  };
}

const STATUS_LABEL: Record<BuildStatus, string> = {
  functional: 'Functional',
  partial: 'Partially functional',
  prototype: 'Prototype',
};
const HAS_LABEL: Record<LinkRequirement, string> = {
  live: 'Has live demo',
  repo: 'Has repository',
  video: 'Has demo video',
};

/**
 * Facet options and counts.
 *
 * OPTIONS come from every public project (so picking one option never makes
 * the others disappear); COUNTS apply every active group except the facet's
 * own (so each number is what you would get by choosing that option). The
 * link switches are requirements, so each switch counts with the OTHER active
 * switches still applied.
 */
export async function directoryFacets(db: AnyDatabase, query: DirectoryQuery): Promise<ProjectListResult['facets']> {
  const pub = publicProjectWhere();
  const counted = (group: Group) => filterWhere(query, group);
  const [eventOptions, eventCounts, categories, categoryCounts, cities, cityCounts, statuses, statusCounts, hasRow] =
    await Promise.all([
      countFrom(db, {
        value: sql<string>`coalesce(${schema.events.slug}, ${INDEPENDENT})`,
        title: schema.events.title,
        shortTitle: schema.events.shortTitle,
        date: schema.events.date,
      })
        .where(pub)
        .groupBy(schema.events.slug, schema.events.title, schema.events.shortTitle, schema.events.date) as unknown as Promise<
        { value: string; title: string | null; shortTitle: string | null; date: string | null }[]
      >,
      countFrom(db, { value: sql<string>`coalesce(${schema.events.slug}, ${INDEPENDENT})`, n: count() })
        .where(counted('events'))
        .groupBy(schema.events.slug) as unknown as Promise<{ value: string; n: number }[]>,
      countFrom(db, { value: schema.projects.category }).where(pub).groupBy(schema.projects.category) as unknown as Promise<{ value: string }[]>,
      countFrom(db, { value: schema.projects.category, n: count() })
        .where(counted('categories'))
        .groupBy(schema.projects.category) as unknown as Promise<{ value: string; n: number }[]>,
      countFrom(db, { value: eventCity.slug, label: eventCity.name })
        .where(and(pub, isNotNull(eventCity.slug)))
        .groupBy(eventCity.slug, eventCity.name) as unknown as Promise<{ value: string; label: string }[]>,
      countFrom(db, { value: eventCity.slug, n: count() })
        .where(and(counted('cities'), isNotNull(eventCity.slug)))
        .groupBy(eventCity.slug) as unknown as Promise<{ value: string; n: number }[]>,
      countFrom(db, { value: schema.projects.buildStatus })
        .where(and(pub, isNotNull(schema.projects.buildStatus)))
        .groupBy(schema.projects.buildStatus) as unknown as Promise<{ value: string }[]>,
      countFrom(db, { value: schema.projects.buildStatus, n: count() })
        .where(and(counted('statuses'), isNotNull(schema.projects.buildStatus)))
        .groupBy(schema.projects.buildStatus) as unknown as Promise<{ value: string; n: number }[]>,
      countFrom(
        db,
        Object.fromEntries(
          LINK_REQUIREMENTS.map((h) => {
            const others = query.has.filter((x) => x !== h).map((x) => HAS_COLUMN[x]);
            const condition = and(HAS_COLUMN[h], ...others)!;
            return [h, sql<number>`count(*) FILTER (WHERE ${condition})`.mapWith(Number)];
          }),
        ),
      ).where(counted('has')) as unknown as Promise<Record<LinkRequirement, number>[]>,
    ]);

  const countOf = (rows: { value: string; n: number }[], value: string) => Number(rows.find((r) => r.value === value)?.n ?? 0);

  const events: Facet[] = eventOptions
    .filter((e) => e.value !== INDEPENDENT)
    .map((e) => ({
      value: e.value,
      label: eventLabel(e.title ?? e.value, e.shortTitle),
      date: String(e.date).slice(0, 10) as IsoDate,
      count: countOf(eventCounts, e.value),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.label.localeCompare(b.label));
  if (eventOptions.some((e) => e.value === INDEPENDENT)) {
    events.push({ value: INDEPENDENT, label: 'Independent projects', count: countOf(eventCounts, INDEPENDENT) });
  }

  return {
    events,
    categories: categories
      .map((c) => ({ value: c.value, label: c.value, count: countOf(categoryCounts, c.value) }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    cities: cities
      .map((c) => ({ value: c.value, label: c.label, count: countOf(cityCounts, c.value) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    statuses: (schema.projectBuildStatus.enumValues as readonly BuildStatus[])
      .filter((s) => statuses.some((r) => r.value === s))
      .map((s) => ({ value: s, label: STATUS_LABEL[s], count: countOf(statusCounts, s) })),
    has: LINK_REQUIREMENTS.map((h) => ({ value: h, label: HAS_LABEL[h], count: Number(hasRow[0]?.[h] ?? 0) })),
  };
}

/** Public projects built at one event, with the true count — the event page. */
export async function publicProjectsForEvent(
  db: AnyDatabase,
  eventId: string,
  limit = 60,
): Promise<PublicProjectCard[]> {
  const rows = (await selectCards(db)
    .where(and(publicProjectWhere(), eq(schema.projects.builtAtEventId, eventId)))
    .orderBy(...orderFor('name'))
    .limit(limit)) as CardRow[];
  return cards(db, rows);
}

export async function publicProjectCountForEvent(db: AnyDatabase, eventId: string): Promise<number> {
  // The same joins as the directory, so an event whose own row is not public
  // reports zero here exactly as its directory filter would.
  const [{ n }] = (await countFrom(db, { n: count() }).where(
    and(publicProjectWhere(), eq(schema.projects.builtAtEventId, eventId), isNotNull(schema.events.id)),
  )) as unknown as { n: number }[];
  return Number(n);
}

/** Public projects credited to a builder (by credit or by ownership). */
export async function publicProjectsForBuilder(
  db: AnyDatabase,
  builder: { id: string; ownerMemberId: string | null },
  limit = 60,
): Promise<PublicProjectCard[]> {
  const credited = sql`${schema.projects.id} IN (SELECT project_id FROM project_builders WHERE builder_id = ${builder.id})`;
  const owned = builder.ownerMemberId ? eq(schema.projects.ownerMemberId, builder.ownerMemberId) : undefined;
  const rows = (await selectCards(db)
    .where(and(publicProjectWhere(), owned ? or(credited, owned) : credited))
    .orderBy(...orderFor('recent'))
    .limit(limit)) as CardRow[];
  return cards(db, rows);
}

/** The homepage's strip: featured first when anything is featured, otherwise newest event. */
export async function featuredPublicProjects(db: AnyDatabase, limit = 6): Promise<PublicProjectCard[]> {
  const result = await listPublicProjects(db, { sort: 'featured', pageSize: limit });
  return result.items;
}

// ── one project ─────────────────────────────────────────────────────────

/**
 * One project by slug, REGARDLESS of visibility — the caller decides, using
 * `isPublic`, whether to render it, 404 it, or show a moderator banner with
 * a private response. Three bounded queries in total.
 */
export async function getProjectDetail(db: AnyDatabase, slug: string): Promise<PublicProjectDetail | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)) return null;

  const [row] = await db
    .select({
      ...cardColumns,
      description: schema.projects.description,
      claudeUsage: schema.projects.claudeUsage,
      problem: schema.projects.problem,
      solution: schema.projects.solution,
      builtWith: schema.projects.builtWith,
      altVideoUrl: schema.projects.altVideoUrl,
      artifactUrl: schema.projects.artifactUrl,
      publishedAt: schema.projects.publishedAt,
      updatedAt: schema.projects.updatedAt,
      publicationStatus: schema.projects.publicationStatus,
      moderationState: schema.projects.moderationState,
      deletedAt: schema.projects.deletedAt,
    })
    .from(schema.projects)
    .leftJoin(projectCity, publicProjectCityJoin)
    .leftJoin(schema.events, publicEventJoin)
    .leftJoin(eventCity, publicEventCityJoin)
    .leftJoin(cover, eq(cover.id, schema.projects.imageId))
    .leftJoin(logoMedia, eq(logoMedia.id, schema.projects.logoMediaId))
    .where(eq(schema.projects.slug, slug));

  if (!row) return null;

  const [credits, useCases] = await Promise.all([
    creditsFor(db, [row.id]),
    db
      .select({ slug: schema.useCases.slug, title: schema.useCases.title })
      .from(schema.useCases)
      .where(and(eq(schema.useCases.projectId, row.id), eq(schema.useCases.status, 'published'))),
  ]);

  const isPublic = row.publicationStatus === 'published' && row.moderationState === 'clean' && !row.deletedAt;

  return {
    ...toCard(row as CardRow, credits.get(row.id) ?? NO_CREDITS),
    description: row.description,
    claudeUsage: row.claudeUsage,
    problem: row.problem,
    solution: row.solution,
    builtWith: row.builtWith,
    url: row.url,
    repoUrl: row.repoUrl,
    videoUrl: row.videoUrl,
    altVideoUrl: row.altVideoUrl,
    downloadUrl: row.downloadUrl,
    artifactUrl: row.artifactUrl,
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
 * Other public projects: from the same event first, then the same project
 * city, never the project itself.
 */
export async function relatedPublicProjects(
  db: AnyDatabase,
  project: { id: string; event: { slug: string } | null; city: { slug: string } | null },
  limit = 4,
): Promise<PublicProjectCard[]> {
  if (!project.event && !project.city) return [];
  const sameEvent = project.event ? sql`(${schema.events.slug} = ${project.event.slug})` : sql`false`;
  const sameCity = project.city ? sql`(${projectCity.slug} = ${project.city.slug})` : sql`false`;
  const rows = (await selectCards(db)
    .where(and(publicProjectWhere(), ne(schema.projects.id, project.id), or(sameEvent, sameCity)))
    // Same-event first only when there IS an event: a bare `false` is not a
    // valid ORDER BY term in PostgreSQL ("non-integer constant in ORDER BY").
    // Within that, a stable per-project rotation so neighbours vary by page.
    .orderBy(
      ...(project.event ? [sql`${sameEvent} DESC NULLS LAST`] : []),
      sql`md5(${schema.projects.slug} || ${project.id}) ASC`,
      asc(schema.projects.slug),
    )
    .limit(limit)) as CardRow[];
  return cards(db, rows);
}
