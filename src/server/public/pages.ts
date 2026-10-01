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
import {
  featuredPublicProjects,
  getProjectDetail,
  listPublicProjects,
  normaliseProjectQuery,
  publicProjectsForBuilder,
  publicProjectsForEvent,
  relatedPublicProjects,
  type ProjectListResult,
  type PublicProjectCard,
  type PublicProjectDetail,
} from './projects';
import { latestPastEvents, upcomingPublicEvents, type PublicEventCard } from './events';
import { communityCounts, featuredPublicBuilders, type PublicBuilderCard } from './builders';

export type { ProjectListResult, PublicProjectCard, PublicProjectDetail };

export function projectArchive(params: URLSearchParams): Promise<ProjectListResult> {
  return listPublicProjects(pooledDb(), normaliseProjectQuery(params));
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

export function homepageProjects(limit = 6): Promise<PublicProjectCard[]> {
  return featuredPublicProjects(pooledDb(), limit);
}

export function eventProjects(eventId: string): Promise<PublicProjectCard[]> {
  return publicProjectsForEvent(pooledDb(), eventId);
}

export function builderProjects(builder: {
  id: string;
  ownerMemberId: string | null;
}): Promise<PublicProjectCard[]> {
  return publicProjectsForBuilder(pooledDb(), builder);
}

// ── the homepage ─────────────────────────────────────────────────────────


export type { PublicEventCard, PublicBuilderCard };

export interface HomeData {
  upcoming: PublicEventCard[];
  /** Shown only when nothing is upcoming. */
  latest: PublicEventCard | null;
  projects: PublicProjectCard[];
  builders: PublicBuilderCard[];
  counts: Awaited<ReturnType<typeof communityCounts>>;
}

/**
 * Everything the homepage renders, live, in one call. Each part is a bounded
 * query; nothing reads the build-time snapshot, so the homepage can no longer
 * disagree with the directory pages it links to.
 */
export async function homeData(now: Date = new Date()): Promise<HomeData> {
  const db = pooledDb();
  const [upcoming, projects, builders, counts] = await Promise.all([
    upcomingPublicEvents(db, now, 3),
    featuredPublicProjects(db, 6),
    featuredPublicBuilders(db, 6),
    communityCounts(db),
  ]);
  const latest = upcoming.length === 0 ? ((await latestPastEvents(db, now, 1))[0] ?? null) : null;
  return { upcoming, latest, projects, builders, counts };
}
