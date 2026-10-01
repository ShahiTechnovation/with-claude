/**
 * PUBLIC EVENT READS — bounded, for the homepage and event surfaces.
 *
 * Lifecycle (upcoming / live / past / cancelled) is NOT stored and NOT decided
 * here: `lifecycleOf()` in `src/lib/status.ts` is the one answer, computed from
 * the date, the times and the door override. This module only fetches the
 * candidate rows and hands them over in the shape that function reads.
 *
 * `canceled_at` (set by ingestion when an event disappears from its feed, or
 * the source cancels it) is folded into the `cancelled` override, so a feed
 * cancellation stops the Register button everywhere, not only on the detail
 * page.
 */
import { and, asc, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../../../db/schema';
import type { ClockTime, CommunityEvent, EventOverride, IsoDate } from '../../data/types';
import { istDay } from '../../lib/datetime';
import { lifecycleOf } from '../../lib/status';
import { publicProjectWhere } from '../projects/lifecycle';

type AnyDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface PublicEventCard {
  id: string;
  slug: string;
  title: string;
  format: string;
  date: IsoDate;
  startTime: ClockTime;
  endTime?: ClockTime;
  city: { slug: string; name: string };
  venueName: string;
  venuePrivate: boolean;
  summary: string;
  registrationUrl?: string;
  coverImage?: string;
  statusOverride?: EventOverride;
  free: boolean;
  projectCount: number;
}

const columns = {
  id: schema.events.id,
  slug: schema.events.slug,
  title: schema.events.title,
  format: schema.events.format,
  date: schema.events.date,
  startTime: schema.events.startTime,
  endTime: schema.events.endTime,
  citySlug: schema.cities.slug,
  cityName: schema.cities.name,
  venueName: schema.events.venueName,
  venuePrivate: schema.events.venuePrivate,
  summary: schema.events.summary,
  registrationUrl: schema.events.registrationUrl,
  coverImagePath: schema.events.coverImagePath,
  statusOverride: schema.events.statusOverride,
  canceledAt: schema.events.canceledAt,
  free: schema.events.free,
};

type Row = {
  id: string;
  slug: string;
  title: string;
  format: string;
  date: string;
  startTime: string;
  endTime: string | null;
  citySlug: string;
  cityName: string;
  venueName: string;
  venuePrivate: boolean;
  summary: string;
  registrationUrl: string | null;
  coverImagePath: string | null;
  statusOverride: EventOverride | null;
  canceledAt: Date | null;
  free: boolean;
};

const clock = (t: string | null) => (t ? (t.slice(0, 5) as ClockTime) : undefined);

function toCard(row: Row, projectCount: number): PublicEventCard {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    format: row.format,
    date: String(row.date).slice(0, 10) as IsoDate,
    startTime: clock(row.startTime)!,
    endTime: clock(row.endTime),
    city: { slug: row.citySlug, name: row.cityName },
    venueName: row.venueName,
    venuePrivate: row.venuePrivate,
    summary: row.summary,
    ...(row.registrationUrl ? { registrationUrl: row.registrationUrl } : {}),
    ...(row.coverImagePath && !/^[a-z][a-z0-9+.-]*:/i.test(row.coverImagePath)
      ? { coverImage: row.coverImagePath }
      : {}),
    ...(row.canceledAt
      ? { statusOverride: 'cancelled' as const }
      : row.statusOverride
        ? { statusOverride: row.statusOverride }
        : {}),
    free: row.free,
    projectCount,
  };
}

/** The minimal `CommunityEvent` that `lifecycleOf()` reads. */
export function asLifecycleEvent(card: PublicEventCard): CommunityEvent {
  return card as unknown as CommunityEvent;
}

async function projectCounts(db: AnyDatabase, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ eventId: schema.projects.builtAtEventId, n: count() })
    .from(schema.projects)
    .where(and(publicProjectWhere(), inArray(schema.projects.builtAtEventId, ids)))
    .groupBy(schema.projects.builtAtEventId);
  return new Map(rows.map((r) => [r.eventId!, r.n]));
}

const base = (db: AnyDatabase) =>
  db
    .select(columns)
    .from(schema.events)
    .innerJoin(schema.cities, eq(schema.cities.id, schema.events.cityId));

/**
 * Events still ahead (or happening now), soonest first. Candidate rows are
 * bounded by date in SQL — yesterday onwards, to cover an event running past
 * midnight — and the clock decides the rest.
 */
export async function upcomingPublicEvents(
  db: AnyDatabase,
  now: Date = new Date(),
  limit = 3,
): Promise<PublicEventCard[]> {
  const yesterday = istDay(new Date(now.getTime() - 86_400_000));
  const rows = (await base(db)
    .where(and(eq(schema.events.status, 'published'), gte(schema.events.date, yesterday)))
    .orderBy(asc(schema.events.date), asc(schema.events.startTime))
    .limit(limit * 3)) as Row[];
  const counts = await projectCounts(db, rows.map((r) => r.id));
  return rows
    .map((r) => toCard(r, counts.get(r.id) ?? 0))
    .filter((e) => {
      const lifecycle = lifecycleOf(asLifecycleEvent(e), now);
      return lifecycle !== 'past' && lifecycle !== 'cancelled';
    })
    .slice(0, limit);
}

/** The most recent event that has happened, for "latest recap" fallbacks. */
export async function latestPastEvents(
  db: AnyDatabase,
  now: Date = new Date(),
  limit = 1,
): Promise<PublicEventCard[]> {
  const today = istDay(now);
  const rows = (await base(db)
    .where(
      and(
        eq(schema.events.status, 'published'),
        lt(schema.events.date, today),
        sql`${schema.events.canceledAt} IS NULL`,
        sql`(${schema.events.statusOverride} IS NULL OR ${schema.events.statusOverride} <> 'cancelled')`,
      ),
    )
    .orderBy(desc(schema.events.date), desc(schema.events.startTime))
    .limit(limit)) as Row[];
  const counts = await projectCounts(db, rows.map((r) => r.id));
  return rows.map((r) => toCard(r, counts.get(r.id) ?? 0));
}

/** Public projects per event, for the events index and event pages. */
export async function publicProjectCountsForEvents(
  db: AnyDatabase,
  eventIds: string[],
): Promise<Map<string, number>> {
  return projectCounts(db, eventIds);
}
