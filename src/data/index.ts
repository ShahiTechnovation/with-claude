import { istInstant } from '@/lib/datetime';
import { cityState, cityStateRank } from '@/lib/city';
import { lifecycleOf } from '@/lib/status';
import { ambassadors } from './ambassadors';
import { builders } from './builders';
import { cities } from './cities';
import { events } from './events';
import { guides } from './guides';
import { projects } from './projects';
import { stories } from './stories';
import { useCases } from './use-cases';
import type {
  Ambassador,
  Authorship,
  Builder,
  City,
  CityState,
  CommunityEvent,
  EventPhoto,
  Guide,
  ModerationStatus,
  Project,
  RecordBase,
  SignalItem,
  Story,
  UseCase,
} from './types';

export { ambassadors, builders, cities, events, guides, projects, stories, useCases };
export * from './site';
export type * from './types';

/**
 * A record is public once a human has moved it past review. Everything the
 * site renders goes through this — a `pending` submission is invisible, which
 * is the entire point of having the state.
 */
export function isPublic(record: { status: ModerationStatus }): boolean {
  return record.status === 'published' || record.status === 'featured';
}

const publicOnly = <T extends RecordBase>(list: T[]): T[] => list.filter(isPublic);

export const publicAmbassadors = publicOnly(ambassadors);
export const publicBuilders = publicOnly(builders);
export const publicProjects = publicOnly(projects);
export const publicStories = publicOnly(stories);
export const publicEvents = publicOnly(events);
export const publicCities = publicOnly(cities);
export const publicUseCases = publicOnly(useCases);
export const publicGuides = publicOnly(guides);

// =========================================================================
// EVENTS
// =========================================================================

const byDateAsc = (a: CommunityEvent, b: CommunityEvent) =>
  istInstant(a.date, a.startTime).getTime() - istInstant(b.date, b.startTime).getTime();

/** Ascending by start time. */
export const eventsChronological = [...publicEvents].sort(byDateAsc);

/** Everything that has not finished, soonest first. */
export function upcomingEvents(now: Date = new Date()): CommunityEvent[] {
  return eventsChronological.filter((e) => {
    const lifecycle = lifecycleOf(e, now);
    return lifecycle !== 'past' && lifecycle !== 'cancelled';
  });
}

/** Everything that has finished, most recent first. */
export function pastEvents(now: Date = new Date()): CommunityEvent[] {
  return [...eventsChronological].reverse().filter((e) => lifecycleOf(e, now) === 'past');
}

/**
 * THE next event, nationally. Every "next up" on the site reads this — the
 * hero, the nav, the JSON-LD, the meta description. There is no second copy.
 */
export function nextEvent(now: Date = new Date()): CommunityEvent | undefined {
  return upcomingEvents(now)[0];
}

/** Anything running right now. */
export function liveEvents(now: Date = new Date()): CommunityEvent[] {
  return eventsChronological.filter((e) => lifecycleOf(e, now) === 'live');
}

// =========================================================================
// LOOKUPS
// =========================================================================

export const cityBySlug = new Map(cities.map((c) => [c.slug, c]));
export const eventBySlug = new Map(publicEvents.map((e) => [e.slug, e]));
export const builderBySlug = new Map(publicBuilders.map((b) => [b.slug, b]));
export const projectBySlug = new Map(publicProjects.map((p) => [p.slug, p]));
export const storyBySlug = new Map(publicStories.map((s) => [s.slug, s]));
export const ambassadorBySlug = new Map(publicAmbassadors.map((a) => [a.slug, a]));
export const useCaseBySlug = new Map(publicUseCases.map((u) => [u.slug, u]));
export const guideBySlug = new Map(publicGuides.map((g) => [g.slug, g]));

export function getCity(slug: string): City | undefined {
  return cityBySlug.get(slug);
}

/** A city always has a name to render, even if the record is incomplete. */
export function cityName(slug: string): string {
  return cityBySlug.get(slug)?.name ?? slug;
}

// =========================================================================
// THE COMMUNITY GRAPH
// City ↔ Ambassador ↔ Builder ↔ Project ↔ Event ↔ Story
// =========================================================================

export function ambassadorsInCity(slug: string): Ambassador[] {
  return publicAmbassadors.filter((a) => a.citySlug === slug);
}

/** The verified Ambassador hosting an event, if there is one. */
export function hostAmbassador(event: CommunityEvent): Ambassador | undefined {
  return event.host.ambassadorSlug ? ambassadorBySlug.get(event.host.ambassadorSlug) : undefined;
}

/**
 * An event is a verified Claude Community event when its host resolves to a
 * published Ambassador record. There is no flag for this and there must not be.
 */
export function isAmbassadorLed(event: CommunityEvent): boolean {
  return Boolean(hostAmbassador(event));
}

/** Builders who ran a room alongside the Ambassador. */
export function coHostsOf(event: CommunityEvent): Builder[] {
  return (event.host.builderSlugs ?? [])
    .map((slug) => builderBySlug.get(slug))
    .filter((builder): builder is Builder => Boolean(builder));
}

/**
 * Everyone credited with an event, in the order the site prints them:
 * the Ambassador, then co-hosts, then the organisations that lent the room.
 *
 * One function so the archive, the event page and the city page can never
 * credit a room differently from one another.
 */
export function creditsFor(event: CommunityEvent): string[] {
  return [
    hostAmbassador(event)?.name,
    ...coHostsOf(event).map((builder) => builder.name),
    ...(event.host.organisations ?? []),
  ].filter((name): name is string => Boolean(name));
}

export function eventsHostedBy(ambassadorSlug: string): CommunityEvent[] {
  return eventsChronological.filter((e) => e.host.ambassadorSlug === ambassadorSlug);
}

/** The builder-directory entry for an ambassador, when they have one. */
export function builderForAmbassador(ambassador: Ambassador): Builder | undefined {
  return ambassador.builderSlug ? builderBySlug.get(ambassador.builderSlug) : undefined;
}

/** The Ambassador record claiming a builder, if any. Drives the role chip. */
export function ambassadorForBuilder(builder: Builder): Ambassador | undefined {
  return publicAmbassadors.find((a) => a.builderSlug === builder.slug || a.slug === builder.slug);
}

export function eventsInCity(slug: string): CommunityEvent[] {
  return eventsChronological.filter((e) => e.citySlug === slug);
}

export function buildersInCity(slug: string): Builder[] {
  return publicBuilders.filter((b) => b.citySlug === slug);
}

export function projectsInCity(slug: string): Project[] {
  return publicProjects.filter((p) => p.citySlug === slug);
}

export function storiesInCity(slug: string): Story[] {
  return publicStories.filter((s) => s.citySlug === slug);
}

export function speakersOf(event: CommunityEvent): Builder[] {
  return (event.speakerSlugs ?? [])
    .map((s) => builderBySlug.get(s))
    .filter((b): b is Builder => Boolean(b));
}

/** Projects that came out of a given room. The event → project half of the loop. */
export function projectsFromEvent(slug: string): Project[] {
  return publicProjects.filter((p) => p.builtAtEventSlug === slug);
}

/** The people behind a project. The project → person half of the loop. */
export function buildersOf(project: Project): Builder[] {
  return project.builderSlugs
    .map((s) => builderBySlug.get(s))
    .filter((b): b is Builder => Boolean(b));
}

// ── Attribution-only builder resolution ───────────────────────────────
//
// Impact Lab builders are `pending` — they do not get public profile pages,
// but their names must appear on project cards and detail pages as "Built
// by X, Y, Z". This map resolves against ALL builders, not just public ones.

const allBuildersBySlug = new Map(builders.map((b) => [b.slug, b]));

/** Builder name + slug + public status, for attribution display. */
export interface BuilderAttribution {
  name: string;
  slug: string;
  isPublic: boolean;
}

/**
 * Resolve builder names for a project, including pending builders.
 *
 * Published builders get linked profiles. Pending builders get plain-text
 * attribution — their name appears, but there is no profile page to link to.
 */
export function builderNamesOf(project: Project): BuilderAttribution[] {
  return project.builderSlugs
    .map((slug) => {
      const builder = allBuildersBySlug.get(slug);
      return builder
        ? { name: builder.name, slug: builder.slug, isPublic: isPublic(builder) }
        : { name: slug, slug, isPublic: false };
    });
}

/** Everything one builder has made. */
export function projectsOf(builder: Builder): Project[] {
  const declared = (builder.projectSlugs ?? [])
    .map((s) => projectBySlug.get(s))
    .filter((p): p is Project => Boolean(p));
  const credited = publicProjects.filter((p) => p.builderSlugs.includes(builder.slug));
  return [...new Set([...declared, ...credited])];
}

/** Every room one builder has been on the record in. */
export function eventsOf(builder: Builder): CommunityEvent[] {
  const declared = (builder.eventSlugs ?? [])
    .map((s) => eventBySlug.get(s))
    .filter((e): e is CommunityEvent => Boolean(e));
  const credited = eventsChronological.filter((e) => e.speakerSlugs?.includes(builder.slug));
  return [...new Set([...declared, ...credited])].sort(byDateAsc);
}

// -------------------------------------------------------------------------
// USE CASES AND GUIDES — the practice half of the graph
// -------------------------------------------------------------------------

/** Newest first. Practice ages, so the most recent account leads. */
export function useCasesChronological(): UseCase[] {
  return [...publicUseCases].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function guidesChronological(): Guide[] {
  return [...publicGuides].sort((a, b) =>
    (a.modified ?? a.published) < (b.modified ?? b.published) ? 1 : -1,
  );
}

/**
 * The builder behind a byline.
 *
 * An `Authorship` can name someone who has no profile yet, so this resolves
 * where it can and the UI falls back to the plain name where it cannot.
 */
export function authorOf(record: { author: Authorship }): Builder | undefined {
  return record.author.builderSlug ? builderBySlug.get(record.author.builderSlug) : undefined;
}

/** The name to print on a byline, resolved profile or not. */
export function authorName(record: { author: Authorship }): string {
  return authorOf(record)?.name ?? record.author.name ?? 'The community';
}

export function useCasesInCity(slug: string): UseCase[] {
  return publicUseCases.filter((u) => u.citySlug === slug);
}

/** Everything one builder has written up. */
export function useCasesBy(builderSlug: string): UseCase[] {
  return useCasesChronological().filter((u) => u.author.builderSlug === builderSlug);
}

export function guidesBy(builderSlug: string): Guide[] {
  return guidesChronological().filter(
    (g) => g.author.builderSlug === builderSlug || g.builderSlugs?.includes(builderSlug),
  );
}

/** The practice written up around one project — the project → knowledge edge. */
export function useCasesForProject(slug: string): UseCase[] {
  return publicUseCases.filter((u) => u.projectSlug === slug);
}

/** What came out of a room, in writing. */
export function useCasesForEvent(slug: string): UseCase[] {
  return publicUseCases.filter((u) => u.eventSlug === slug);
}

export function guidesForEvent(slug: string): Guide[] {
  return publicGuides.filter((g) => g.eventSlugs?.includes(slug));
}

/** Which Claude surfaces the community has actually documented using. */
export function claudeSurfaces(): string[] {
  const surfaces = new Set<string>();
  for (const useCase of publicUseCases) for (const tool of useCase.tools) surfaces.add(tool);
  for (const builder of publicBuilders)
    for (const tool of builder.claudeTools ?? []) surfaces.add(tool);
  return [...surfaces].sort();
}

export function storiesChronological(): Story[] {
  return [...publicStories].sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function storiesForEvent(slug: string): Story[] {
  return publicStories.filter((s) => s.eventSlug === slug);
}

// =========================================================================
// CITY STATE — derived, never authored
// =========================================================================

export interface CitySignal {
  city: City;
  state: CityState;
  ambassadors: Ambassador[];
  eventCount: number;
  heldCount: number;
  builderCount: number;
  projectCount: number;
  storyCount: number;
  interestCount: number;
  next?: CommunityEvent;
}

/** The next event in a given city, if any. */
export function nextEventInCity(slug: string, now: Date = new Date()): CommunityEvent | undefined {
  return upcomingEvents(now).find((e) => e.citySlug === slug);
}

export function citySignal(city: City, now: Date = new Date()): CitySignal {
  const cityAmbassadors = ambassadorsInCity(city.slug);
  const cityEvents = eventsInCity(city.slug);
  const interestCount = city.interest?.count ?? 0;

  return {
    city,
    state: cityState({
      hasAmbassador: cityAmbassadors.length > 0,
      eventCount: cityEvents.length,
      interestCount,
    }),
    ambassadors: cityAmbassadors,
    eventCount: cityEvents.length,
    heldCount: cityEvents.filter((e) => lifecycleOf(e, now) === 'past').length,
    builderCount: buildersInCity(city.slug).length,
    projectCount: projectsInCity(city.slug).length,
    storyCount: storiesInCity(city.slug).length,
    interestCount,
    next: nextEventInCity(city.slug, now),
  };
}

/** Everything the map and the city index need, computed once. */
export function citySignals(now: Date = new Date()): CitySignal[] {
  return publicCities.map((city) => citySignal(city, now));
}

/** Most active first, then alphabetical within a state. */
export function citySignalsRanked(now: Date = new Date()): CitySignal[] {
  return citySignals(now).sort(
    (a, b) =>
      cityStateRank(a.state) - cityStateRank(b.state) || a.city.name.localeCompare(b.city.name),
  );
}

export function citiesInState(state: CityState, now: Date = new Date()): CitySignal[] {
  return citySignals(now).filter((s) => s.state === state);
}

// =========================================================================
// NATIONAL SIGNAL
// =========================================================================

export interface NationalSignal {
  /** Events actually held. */
  eventsHeld: number;
  /** Events on the calendar. */
  eventsScheduled: number;
  citiesPlotted: number;
  /** Cities with a verified Ambassador. */
  citiesAmbassadorLed: number;
  /** Cities with events but no assigned Ambassador. */
  citiesWithActivity: number;
  /** Cities where people have registered interest. */
  citiesWithInterest: number;
  builders: number;
  projects: number;
  stories: number;
  useCases: number;
  guides: number;
  ambassadors: number;
  /** Community-reported figures, summed. Undefined when none are reported. */
  reportedMembers?: number;
  /** Where the reported figures came from, so the UI can attribute them. */
  reportedSources: string[];
}

/**
 * The numbers behind the signal strip.
 *
 * Every figure is counted from the record. The only ones that are not are the
 * community-reported figures, which are kept separate and carry their source
 * so the UI can label them honestly rather than folding them into a headline.
 */
export function nationalSignal(now: Date = new Date()): NationalSignal {
  const signals = citySignals(now);
  const reported = publicCities.filter((c) => c.reported);
  const members = reported.reduce((sum, c) => sum + (c.reported?.members ?? 0), 0);

  return {
    eventsHeld: pastEvents(now).length,
    eventsScheduled: upcomingEvents(now).length,
    citiesPlotted: signals.length,
    citiesAmbassadorLed: signals.filter((s) => s.state === 'ambassador-led').length,
    citiesWithActivity: signals.filter((s) => s.state === 'event-activity').length,
    citiesWithInterest: signals.filter((s) => s.state === 'community-interest').length,
    builders: publicBuilders.length,
    projects: publicProjects.length,
    stories: publicStories.length,
    useCases: publicUseCases.length,
    guides: publicGuides.length,
    ambassadors: publicAmbassadors.length,
    reportedMembers: members > 0 ? members : undefined,
    reportedSources: reported.map((c) => c.reported!.source),
  };
}

// =========================================================================
// THE COMMUNITY FEED
// =========================================================================

/**
 * Everything in the record that carries a real date, in two piles.
 *
 * There is no authored feed file, so there is nothing here to invent — if the
 * community is quiet, the feed is short, and that is the honest reading. The
 * activity feed and the timeline both read this, so the two can never drift
 * into telling different stories about the same month.
 */
function assembleSignals(now: Date): { scheduled: SignalItem[]; recent: SignalItem[] } {
  const scheduled: SignalItem[] = upcomingEvents(now).map((event) => ({
    kind: 'event-scheduled',
    date: event.date,
    subject: event.title,
    action: 'on the calendar',
    citySlug: event.citySlug,
    href: `/events/${event.slug}`,
  }));

  const held: SignalItem[] = pastEvents(now).map((event) => ({
    kind: 'event-held',
    date: event.date,
    subject: event.title,
    action: 'held',
    citySlug: event.citySlug,
    href: `/events/${event.slug}`,
  }));

  // Only records that carry a real date can appear. An unknown `createdAt` is
  // left undefined in the data rather than guessed, so these lists stay honest.
  const joined: SignalItem[] = publicBuilders
    .filter((b) => b.createdAt)
    .map((b) => ({
      kind: 'builder-published',
      date: b.createdAt!,
      subject: b.name,
      action: 'joined the index',
      citySlug: b.citySlug,
      href: `/builders/${b.slug}`,
    }));

  const shipped: SignalItem[] = publicProjects
    .filter((p) => p.createdAt)
    .map((p) => ({
      kind: 'project-published',
      date: p.createdAt!,
      subject: p.title,
      action: 'added to the archive',
      citySlug: p.citySlug,
      href: `/projects/${p.slug}`,
    }));

  const written: SignalItem[] = publicStories.map((s) => ({
    kind: 'story-published',
    date: s.date,
    subject: s.title,
    action: 'published',
    citySlug: s.citySlug,
    href: `/stories/${s.slug}`,
  }));

  const documented: SignalItem[] = publicUseCases.map((u) => ({
    kind: 'use-case-published',
    date: u.date,
    subject: u.title,
    action: 'written up',
    citySlug: u.citySlug,
    href: `/use-cases/${u.slug}`,
  }));

  const explained: SignalItem[] = publicGuides.map((g) => ({
    kind: 'guide-published',
    date: g.modified ?? g.published,
    subject: g.title,
    action: g.modified ? 'updated' : 'published',
    href: `/guides/${g.slug}`,
  }));

  const recent = [...held, ...joined, ...shipped, ...written, ...documented, ...explained].sort(
    (a, b) => (a.date < b.date ? 1 : -1),
  );

  return { scheduled, recent };
}

/**
 * A merged stream of things that actually happened: what is on the calendar,
 * soonest first, then what has been held, most recent first.
 */
export function communitySignal(limit = 6, now: Date = new Date()): SignalItem[] {
  const { scheduled, recent } = assembleSignals(now);
  return [...scheduled, ...recent].slice(0, limit);
}

// =========================================================================
// COMMUNITY MEMORY — the record, by month
// =========================================================================

export interface TimelineEntry extends SignalItem {
  /** True when this has not happened yet. Drives the unfilled marker. */
  ahead: boolean;
}

export interface TimelineMonth {
  /** `2026-09` — the sort key and the anchor id. */
  key: string;
  year: number;
  /** Three letters, e.g. `SEP`. */
  month: string;
  /** True when the year changes at this month, so the rail can label it once. */
  opensYear: boolean;
  entries: TimelineEntry[];
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * THE RECORD — every dated thing in the community, grouped by month.
 *
 * Reads forward in time, because that is what a record is: it starts where
 * the community started and ends at what is next. Every entry comes from a
 * record carrying a real date, so a quiet month is genuinely a quiet month
 * and there is nothing here anyone had to write.
 */
export function timeline(now: Date = new Date()): TimelineMonth[] {
  const { scheduled, recent } = assembleSignals(now);
  const entries: TimelineEntry[] = [
    ...scheduled.map((item) => ({ ...item, ahead: true })),
    ...recent.map((item) => ({ ...item, ahead: false })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const months = new Map<string, TimelineMonth>();
  for (const entry of entries) {
    const [year, month] = entry.date.split('-');
    const key = `${year}-${month}`;
    let bucket = months.get(key);
    if (!bucket) {
      bucket = {
        key,
        year: Number(year),
        month: MONTHS[Number(month) - 1] ?? month,
        opensYear: false,
        entries: [],
      };
      months.set(key, bucket);
    }
    bucket.entries.push(entry);
  }

  const ordered = [...months.values()];
  ordered.forEach((bucket, i) => {
    bucket.opensYear = i === 0 || ordered[i - 1].year !== bucket.year;
  });
  return ordered;
}

// =========================================================================
// THE PHOTOGRAPHIC RECORD
// =========================================================================

export interface PhotoRecordItem extends EventPhoto {
  event: CommunityEvent;
  /** `06/02` — plate number within the archive, for the caption stamp. */
  plate: string;
}

/**
 * FROM THE COMMUNITY runs on real photography until written stories exist.
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
