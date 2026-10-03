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
  getProjectDetail,
  listPublicProjects,
  normaliseDirectoryQuery,
  publicProjectCountForEvent,
  publicProjectsForBuilder,
  publicProjectsForEvent,
  relatedPublicProjects,
  type ProjectListResult,
  type PublicProjectCard,
  type PublicProjectDetail,
} from './projects';

export type { ProjectListResult, PublicProjectCard, PublicProjectDetail };

export function projectArchive(params: URLSearchParams): Promise<ProjectListResult> {
  return listPublicProjects(pooledDb(), normaliseDirectoryQuery(params));
}

export async function projectPage(
  slug: string,
): Promise<{ project: PublicProjectDetail; related: PublicProjectCard[] } | null> {
  const db = pooledDb();
  const project = await getProjectDetail(db, slug);
  if (!project) return null;
  const related = project.isPublic ? await relatedPublicProjects(db, project) : [];
  return { project, related };
}

/** An event's public projects and their true count — the same predicate as the directory. */
export async function eventProjects(eventId: string, limit = 60): Promise<{ items: PublicProjectCard[]; total: number }> {
  const db = pooledDb();
  const [items, total] = await Promise.all([publicProjectsForEvent(db, eventId, limit), publicProjectCountForEvent(db, eventId)]);
  return { items, total };
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
