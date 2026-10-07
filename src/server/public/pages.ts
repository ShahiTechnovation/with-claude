/**
 * PAGE-FACING PUBLIC READS.
 *
 * Pages may not import a database module (`tests/admin-isolation.test.ts`), so
 * this is where a server-rendered public page gets its connection: each
 * function opens the pooled connection and calls the bounded query module.
 * Nothing here decides visibility — `src/server/public/projects.ts` and
 * `src/server/projects/lifecycle.ts` do.
 */
import { pooledDb } from '../../../db/pool';
import { RecordSelectors } from '../../data/selectors';
import { requireAsset } from '../../lib/images';
import { loadLiveRecords } from '../directory';
import {
  allPublicProjectCards,
  getProjectDetail,
  listPublicProjects,
  normaliseDirectoryQuery,
  publicProjectCountForEvent,
  publicProjectsForBuilder,
  publicProjectsForEvent,
  relatedPublicProjects,
  type ProjectListResult,
  type PublicEventRef,
  type PublicProjectCard,
  type PublicProjectDetail,
} from './projects';

export type { ProjectListResult, PublicEventRef, PublicProjectCard, PublicProjectDetail };

export function projectArchive(params: URLSearchParams): Promise<ProjectListResult> {
  return listPublicProjects(pooledDb(), normaliseDirectoryQuery(params));
}

/** A project, three neighbours, and how many public projects its event has ("All 76 projects from …"). */
export async function projectPage(slug: string): Promise<{
  project: PublicProjectDetail;
  related: PublicProjectCard[];
  eventTotal: number;
} | null> {
  const db = pooledDb();
  const project = await getProjectDetail(db, slug);
  if (!project) return null;
  const [related, eventTotal] = project.isPublic
    ? await Promise.all([
        relatedPublicProjects(db, project, 3),
        project.event ? publicProjectCountForEvent(db, project.event.id) : 0,
      ])
    : [[], 0];
  return { project, related, eventTotal };
}

/** An event's public projects and their true count — the same predicate as the directory. */
export async function eventProjects(
  eventId: string,
  limit = 60,
): Promise<{ items: PublicProjectCard[]; total: number }> {
  const db = pooledDb();
  const [items, total] = await Promise.all([
    publicProjectsForEvent(db, eventId, limit),
    publicProjectCountForEvent(db, eventId),
  ]);
  return { items, total };
}

/**
 * Every public project, one group per event in arrival order: newest event first, projects with no
 * public event last (`event: null`). Pills, counts and the lead come from the toolbar's
 * `projectArchive()` call, which the page makes anyway.
 *
 * ponytail: reads every public card per uncached render (the CDN keeps it ~60 s); past ~500 projects,
 * show six per group and link to the filtered view.
 */
export async function projectGroups(
  db: Parameters<typeof allPublicProjectCards>[0] = pooledDb(),
): Promise<{ event: PublicEventRef | null; items: PublicProjectCard[] }[]> {
  const groups = new Map<
    string | null,
    { event: PublicEventRef | null; items: PublicProjectCard[] }
  >();
  for (const card of await allPublicProjectCards(db)) {
    const key = card.event?.id ?? null;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { event: card.event, items: [] }));
    group.items.push(card);
  }
  return [...groups.values()];
}

export function builderProjects(builder: {
  id: string;
  ownerMemberId: string | null;
}): Promise<PublicProjectCard[]> {
  return publicProjectsForBuilder(pooledDb(), builder);
}

/** The live photographs by event; images resolve here so a missing file fails the read, not the render. */
export async function galleryRooms(db?: Parameters<typeof loadLiveRecords>[0]) {
  const selectors = new RecordSelectors(await loadLiveRecords(db));
  return selectors.photoRecordByEvent().map(({ event, plates }) => ({
    event,
    city: selectors.cityName(event.citySlug),
    plates: plates.map((plate) => ({ ...plate, image: requireAsset(plate.src) })),
  }));
}

export type GalleryRoom = Awaited<ReturnType<typeof galleryRooms>>[number];

/**
 * The event pages that actually resolve.
 *
 * `/events/[slug]` looks the slug up in `RecordSelectors.eventBySlug` over
 * `loadLiveRecords()`, and rewrites to `/not-found/` when it misses. Anything
 * outside this set is a 404 no matter what the database says, so this is the
 * only honest answer to "which event URLs exist".
 *
 * The sitemap reads this instead of querying `events` itself. It used to run
 * its own `status = 'published'` select, which is a superset of what the route
 * will render — the live sitemap advertised 26 event URLs while 9 of them 404d.
 * Copying the route's predicate into the sitemap query would have fixed the
 * symptom and left a second place to forget; sharing the reader means a change
 * to visibility moves both at once.
 *
 * `updatedAt` is the record's, which is a calendar date rather than an
 * instant (`isoDate()` in `src/data/source-db.ts`). Day granularity is all a
 * `<lastmod>` needs and all a crawler reads.
 */
export async function resolvableEvents(
  db?: Parameters<typeof loadLiveRecords>[0],
): Promise<{ slug: string; updatedAt?: string }[]> {
  const selectors = new RecordSelectors(await loadLiveRecords(db));
  return [...selectors.eventBySlug.values()].map((event) => ({
    slug: event.slug,
    updatedAt: event.updatedAt,
  }));
}
