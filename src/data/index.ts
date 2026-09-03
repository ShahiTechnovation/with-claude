import { istInstant } from '@/lib/datetime';
import { statusOf } from '@/lib/status';
import { builders } from './builders';
import { cities } from './cities';
import { events } from './events';
import { projects } from './projects';
import { stories } from './stories';
import type { Builder, City, CommunityEvent, EventPhoto, Project, Story } from './types';

export { builders, cities, events, projects, stories };
export * from './site';
export type * from './types';

const byDateAsc = (a: CommunityEvent, b: CommunityEvent) =>
  istInstant(a.date, a.startTime).getTime() - istInstant(b.date, b.startTime).getTime();

/** Ascending by start time. */
export const eventsChronological = [...events].sort(byDateAsc);

/** Everything that has not finished, soonest first. */
export function upcomingEvents(now: Date = new Date()): CommunityEvent[] {
  return eventsChronological.filter((e) => {
    const s = statusOf(e, now);
    return s !== 'past' && s !== 'cancelled';
  });
}

/** Everything that has finished, most recent first. */
export function pastEvents(now: Date = new Date()): CommunityEvent[] {
  return [...eventsChronological].reverse().filter((e) => statusOf(e, now) === 'past');
}

/**
 * THE next event, nationally. Every "next up" on the site reads this — the
 * hero, the nav, the JSON-LD, the meta description. There is no second copy.
 */
export function nextEvent(now: Date = new Date()): CommunityEvent | undefined {
  return upcomingEvents(now)[0];
}

/** Anything running right now, for the live signal. */
export function liveEvents(now: Date = new Date()): CommunityEvent[] {
  return eventsChronological.filter((e) => statusOf(e, now) === 'live');
}

// --- Lookups -------------------------------------------------------------

export const cityBySlug = new Map(cities.map((c) => [c.slug, c]));
export const eventBySlug = new Map(events.map((e) => [e.slug, e]));
export const builderBySlug = new Map(builders.map((b) => [b.slug, b]));
export const projectBySlug = new Map(projects.map((p) => [p.slug, p]));
export const storyBySlug = new Map(stories.map((s) => [s.slug, s]));

export function getCity(slug: string): City | undefined {
  return cityBySlug.get(slug);
}

/** A city always has a name to render, even if the record is incomplete. */
export function cityName(slug: string): string {
  return cityBySlug.get(slug)?.name ?? slug;
}

export function eventsInCity(slug: string): CommunityEvent[] {
  return eventsChronological.filter((e) => e.citySlug === slug);
}

export function buildersInCity(slug: string): Builder[] {
  return builders.filter((b) => b.citySlug === slug);
}

export function projectsInCity(slug: string): Project[] {
  return projects.filter((p) => p.citySlug === slug);
}

export function speakersOf(event: CommunityEvent): Builder[] {
  return (event.speakerSlugs ?? [])
    .map((s) => builderBySlug.get(s))
    .filter((b): b is Builder => Boolean(b));
}

export function storiesChronological(): Story[] {
  return [...stories].sort((a, b) => (a.date < b.date ? 1 : -1));
}

// --- Cities --------------------------------------------------------------

export const activeCities = cities.filter((c) => c.status === 'active');
export const formingCities = cities.filter((c) => c.status === 'forming');
export const openCities = cities.filter((c) => c.status === 'open');

/**
 * The next event in a given city, if any. Drives the map's hover card.
 */
export function nextEventInCity(slug: string, now: Date = new Date()): CommunityEvent | undefined {
  return upcomingEvents(now).find((e) => e.citySlug === slug);
}

export interface CitySignal {
  city: City;
  eventCount: number;
  builderCount: number;
  projectCount: number;
  next?: CommunityEvent;
}

/** Everything the map and the city cards need, computed once. */
export function citySignals(now: Date = new Date()): CitySignal[] {
  return cities.map((city) => ({
    city,
    eventCount: eventsInCity(city.slug).length,
    builderCount: buildersInCity(city.slug).length,
    projectCount: projectsInCity(city.slug).length,
    next: nextEventInCity(city.slug, now),
  }));
}

// --- National signal -----------------------------------------------------

export interface NationalSignal {
  /** Events actually held (excludes anything still ahead of us). */
  eventsHeld: number;
  /** Events on the calendar. */
  eventsScheduled: number;
  citiesActive: number;
  /** Cities plotted on the map with no chapter yet — the invitation. */
  citiesOpen: number;
  builders: number;
  projects: number;
  /** Chapter-reported member figures, summed. Undefined if none are reported. */
  reportedMembers?: number;
  /** Where the reported figures came from, so the UI can attribute them. */
  reportedSources: string[];
}

/**
 * The numbers behind the LIVE ACROSS INDIA strip. Counts are derived from the
 * record; the only figures that are not are the chapter-reported ones, which
 * carry their source so the UI can label them honestly.
 */
export function nationalSignal(now: Date = new Date()): NationalSignal {
  const reported = cities.filter((c) => c.reported);
  const members = reported.reduce((sum, c) => sum + (c.reported?.members ?? 0), 0);

  return {
    eventsHeld: pastEvents(now).length,
    eventsScheduled: upcomingEvents(now).length,
    citiesActive: activeCities.length,
    citiesOpen: openCities.length,
    builders: builders.length,
    projects: projects.length,
    reportedMembers: members > 0 ? members : undefined,
    reportedSources: reported.map((c) => c.reported!.source),
  };
}

// --- The photographic record --------------------------------------------

export interface PhotoRecordItem extends EventPhoto {
  event: CommunityEvent;
  /** `07 / 03` — plate number within the archive, for the caption stamp. */
  plate: string;
}

/**
 * FROM THE FLOOR runs on real photography until written stories exist.
 * Newest event first, so the most recent room is the one you meet.
 */
export function photoRecord(): PhotoRecordItem[] {
  const out: PhotoRecordItem[] = [];
  const withPhotos = [...eventsChronological].reverse().filter((e) => e.photos?.length);

  for (const event of withPhotos) {
    event.photos!.forEach((photo, i) => {
      out.push({
        ...photo,
        event,
        plate: `${String(event.volume ?? 0).padStart(2, '0')}/${String(i + 1).padStart(2, '0')}`,
      });
    });
  }
  return out;
}
