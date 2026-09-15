import { istInstant } from '@/lib/datetime';
import { cityState, cityStateRank } from '@/lib/city';
import { lifecycleOf } from '@/lib/status';
import { leaderboard, standingOf, type LeaderboardEntry, type LeaderboardWindow } from '@/lib/leaderboard';
import type {
  Ambassador,
  Authorship,
  Builder,
  City,
  CityState,
  CommunityEvent,
  EventHostCredit,
  EventPhoto,
  Guide,
  ModerationStatus,
  Project,
  RecordBase,
  SignalItem,
  Story,
  UseCase,
} from './types';
import type { RecordSet } from './source';

export function isPublic(record: { status: ModerationStatus }): boolean {
  return record.status === 'published' || record.status === 'featured';
}

const publicOnly = <T extends RecordBase>(list: T[]): T[] => list.filter(isPublic);

const byDateAsc = (a: CommunityEvent, b: CommunityEvent) =>
  istInstant(a.date, a.startTime).getTime() - istInstant(b.date, b.startTime).getTime();

const bySlug = <T extends { slug: string }>(list: T[]): Map<string, T> =>
  new Map(list.map((record) => [record.slug, record]));

export interface BuilderAttribution {
  name: string;
  slug: string;
  isPublic: boolean;
}

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

export interface NationalSignal {
  eventsHeld: number;
  eventsScheduled: number;
  citiesPlotted: number;
  citiesAmbassadorLed: number;
  citiesWithActivity: number;
  citiesWithInterest: number;
  builders: number;
  projects: number;
  stories: number;
  useCases: number;
  guides: number;
  ambassadors: number;
  reportedMembers?: number;
  reportedSources: string[];
}

export interface TimelineEntry extends SignalItem {
  ahead: boolean;
}

export interface TimelineMonth {
  key: string;
  year: number;
  month: string;
  opensYear: boolean;
  entries: TimelineEntry[];
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export interface PhotoRecordItem extends EventPhoto {
  event: CommunityEvent;
  plate: string;
}

/**
 * Parameterized data selectors for a specific dataset.
 *
 * For SSR, one instance is created per request, guaranteeing that Request A's
 * data is never observable by Request B.
 *
 * For SSG/static rendering, `src/data/index.ts` exposes a singleton instance
 * bound to the build-time dataset.
 */
export class RecordSelectors {
  public readonly ambassadors: Ambassador[];
  public readonly builders: Builder[];
  public readonly cities: City[];
  public readonly events: CommunityEvent[];
  public readonly guides: Guide[];
  public readonly projects: Project[];
  public readonly stories: Story[];
  public readonly useCases: UseCase[];

  public readonly publicAmbassadors: Ambassador[];
  public readonly publicBuilders: Builder[];
  public readonly publicProjects: Project[];
  public readonly publicStories: Story[];
  public readonly publicEvents: CommunityEvent[];
  public readonly publicCities: City[];
  public readonly publicUseCases: UseCase[];
  public readonly publicGuides: Guide[];

  public readonly eventsChronological: CommunityEvent[];

  public readonly cityBySlug: Map<string, City>;
  public readonly eventBySlug: Map<string, CommunityEvent>;
  public readonly builderBySlug: Map<string, Builder>;
  public readonly projectBySlug: Map<string, Project>;
  public readonly storyBySlug: Map<string, Story>;
  public readonly ambassadorBySlug: Map<string, Ambassador>;
  public readonly useCaseBySlug: Map<string, UseCase>;
  public readonly guideBySlug: Map<string, Guide>;

  private readonly allBuildersBySlug: Map<string, Builder>;

  constructor(public readonly rs: RecordSet) {
    this.ambassadors = rs.ambassadors;
    this.builders = rs.builders;
    this.cities = rs.cities;
    this.events = rs.events;
    this.guides = rs.guides;
    this.projects = rs.projects;
    this.stories = rs.stories;
    this.useCases = rs.useCases;

    this.publicAmbassadors = publicOnly(rs.ambassadors);
    this.publicBuilders = this.builders.filter((b) => isPublic(b) && b.profileVisibility !== 'unlisted');
    this.publicProjects = publicOnly(rs.projects);
    this.publicStories = publicOnly(rs.stories);
    this.publicEvents = publicOnly(rs.events);
    this.publicCities = publicOnly(rs.cities);
    this.publicUseCases = publicOnly(rs.useCases);
    this.publicGuides = publicOnly(rs.guides);

    this.eventsChronological = [...this.publicEvents].sort(byDateAsc);

    this.cityBySlug = bySlug(this.publicCities);
    this.eventBySlug = bySlug(this.publicEvents);
    this.builderBySlug = bySlug(this.publicBuilders);
    this.projectBySlug = bySlug(this.publicProjects);
    this.storyBySlug = bySlug(this.publicStories);
    this.ambassadorBySlug = bySlug(this.publicAmbassadors);
    this.useCaseBySlug = bySlug(this.publicUseCases);
    this.guideBySlug = bySlug(this.publicGuides);

    this.allBuildersBySlug = bySlug(this.builders);
  }

  // =========================================================================
  // EVENTS
  // =========================================================================

  upcomingEvents(now: Date = new Date()): CommunityEvent[] {
    return this.eventsChronological.filter((e) => {
      const lifecycle = lifecycleOf(e, now);
      return lifecycle !== 'past' && lifecycle !== 'cancelled';
    });
  }

  pastEvents(now: Date = new Date()): CommunityEvent[] {
    return [...this.eventsChronological].reverse().filter((e) => lifecycleOf(e, now) === 'past');
  }

  nextEvent(now: Date = new Date()): CommunityEvent | undefined {
    return this.upcomingEvents(now)[0];
  }

  liveEvents(now: Date = new Date()): CommunityEvent[] {
    return this.eventsChronological.filter((e) => lifecycleOf(e, now) === 'live');
  }

  // =========================================================================
  // LOOKUPS
  // =========================================================================

  getCity(slug: string): City | undefined {
    return this.cityBySlug.get(slug);
  }

  cityName(slug: string): string {
    return this.cityBySlug.get(slug)?.name ?? slug;
  }

  // =========================================================================
  // THE COMMUNITY GRAPH
  // =========================================================================

  ambassadorsInCity(slug: string): Ambassador[] {
    return this.publicAmbassadors.filter((a) => a.citySlug === slug);
  }

  hostAmbassador(event: CommunityEvent): Ambassador | undefined {
    return event.host.ambassadorSlug ? this.ambassadorBySlug.get(event.host.ambassadorSlug) : undefined;
  }

  isAmbassadorLed(event: CommunityEvent): boolean {
    return Boolean(this.hostAmbassador(event));
  }

  coHostsOf(event: CommunityEvent): Builder[] {
    return (event.host.builderSlugs ?? [])
      .map((slug) => this.builderBySlug.get(slug))
      .filter((builder): builder is Builder => Boolean(builder));
  }

  creditsFor(event: CommunityEvent): string[] {
    return [
      this.hostAmbassador(event)?.name,
      ...this.coHostsOf(event).map((builder) => builder.name),
      ...(event.host.organisations ?? []),
    ].filter((name): name is string => Boolean(name));
  }

  venueLabel(event: CommunityEvent): string | undefined {
    const { name, address, private: isPrivate } = event.venue;
    if (isPrivate) return undefined;
    if (name === this.cityName(event.citySlug)) return undefined;
    return address && !name.includes(address) ? `${name}, ${address}` : name;
  }

  eventsHostedBy(ambassadorSlug: string): CommunityEvent[] {
    return this.eventsChronological.filter((e) =>
      (e.host.credits ?? []).some((credit) => credit.ambassadorSlug === ambassadorSlug),
    );
  }

  activityLeaderboard(options: { window?: LeaderboardWindow; now?: Date } = {}): LeaderboardEntry[] {
    return leaderboard(this.publicAmbassadors, this.publicEvents, options);
  }

  ambassadorStanding(slug: string, now?: Date) {
    return standingOf(slug, this.publicAmbassadors, this.publicEvents, { now });
  }

  eventCredits(event: CommunityEvent): { credit: EventHostCredit; ambassador: Ambassador }[] {
    return (event.host.credits ?? [])
      .map((credit) => {
        const ambassador = this.ambassadorBySlug.get(credit.ambassadorSlug);
        return ambassador ? { credit, ambassador } : undefined;
      })
      .filter((entry): entry is { credit: EventHostCredit; ambassador: Ambassador } => Boolean(entry));
  }

  builderForAmbassador(ambassador: Ambassador): Builder | undefined {
    return ambassador.builderSlug ? this.builderBySlug.get(ambassador.builderSlug) : undefined;
  }

  ambassadorForBuilder(builder: Builder): Ambassador | undefined {
    return this.publicAmbassadors.find((a) => a.builderSlug === builder.slug || a.slug === builder.slug);
  }

  eventsInCity(slug: string): CommunityEvent[] {
    return this.eventsChronological.filter((e) => e.citySlug === slug);
  }

  buildersInCity(slug: string): Builder[] {
    return this.publicBuilders.filter((b) => b.citySlug === slug);
  }

  projectsInCity(slug: string): Project[] {
    return this.publicProjects.filter((p) => p.citySlug === slug);
  }

  storiesInCity(slug: string): Story[] {
    return this.publicStories.filter((s) => s.citySlug === slug);
  }

  speakersOf(event: CommunityEvent): Builder[] {
    return (event.speakerSlugs ?? [])
      .map((s) => this.builderBySlug.get(s))
      .filter((b): b is Builder => Boolean(b));
  }

  projectsFromEvent(slug: string): Project[] {
    return this.publicProjects.filter((p) => p.builtAtEventSlug === slug);
  }

  buildersOf(project: Project): Builder[] {
    return project.builderSlugs
      .map((s) => this.builderBySlug.get(s))
      .filter((b): b is Builder => Boolean(b));
  }

  builderNamesOf(project: Project): BuilderAttribution[] {
    return project.builderSlugs
      .map((slug) => {
        const builder = this.allBuildersBySlug.get(slug);
        return builder
          ? { name: builder.name, slug: builder.slug, isPublic: isPublic(builder) }
          : { name: slug, slug, isPublic: false };
      });
  }

  projectsOf(builder: Builder): Project[] {
    const declared = (builder.projectSlugs ?? [])
      .map((s) => this.projectBySlug.get(s))
      .filter((p): p is Project => Boolean(p));
    const credited = this.publicProjects.filter((p) => p.builderSlugs.includes(builder.slug));
    return [...new Set([...declared, ...credited])];
  }

  eventsOf(builder: Builder): CommunityEvent[] {
    const declared = (builder.eventSlugs ?? [])
      .map((s) => this.eventBySlug.get(s))
      .filter((e): e is CommunityEvent => Boolean(e));
    const credited = this.eventsChronological.filter(
      (e) => e.speakerSlugs?.includes(builder.slug) || e.host.builderSlugs?.includes(builder.slug),
    );
    return [...new Set([...declared, ...credited])].sort(byDateAsc);
  }

  // =========================================================================
  // USE CASES AND GUIDES
  // =========================================================================

  useCasesChronological(): UseCase[] {
    return [...this.publicUseCases].sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  guidesChronological(): Guide[] {
    return [...this.publicGuides].sort((a, b) =>
      (a.modified ?? a.published) < (b.modified ?? b.published) ? 1 : -1,
    );
  }

  authorOf(record: { author: Authorship }): Builder | undefined {
    return record.author.builderSlug ? this.builderBySlug.get(record.author.builderSlug) : undefined;
  }

  authorName(record: { author: Authorship }): string {
    return this.authorOf(record)?.name ?? record.author.name ?? 'The community';
  }

  useCasesInCity(slug: string): UseCase[] {
    return this.publicUseCases.filter((u) => u.citySlug === slug);
  }

  useCasesBy(builderSlug: string): UseCase[] {
    return this.useCasesChronological().filter((u) => u.author.builderSlug === builderSlug);
  }

  guidesBy(builderSlug: string): Guide[] {
    return this.guidesChronological().filter(
      (g) => g.author.builderSlug === builderSlug || g.builderSlugs?.includes(builderSlug),
    );
  }

  useCasesForProject(slug: string): UseCase[] {
    return this.publicUseCases.filter((u) => u.projectSlug === slug);
  }

  useCasesForEvent(slug: string): UseCase[] {
    return this.publicUseCases.filter((u) => u.eventSlug === slug);
  }

  guidesForEvent(slug: string): Guide[] {
    return this.publicGuides.filter((g) => g.eventSlugs?.includes(slug));
  }

  claudeSurfaces(): string[] {
    const surfaces = new Set<string>();
    for (const useCase of this.publicUseCases) for (const tool of useCase.tools) surfaces.add(tool);
    for (const builder of this.publicBuilders)
      for (const tool of builder.claudeTools ?? []) surfaces.add(tool);
    return [...surfaces].sort();
  }

  storiesChronological(): Story[] {
    return [...this.publicStories].sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  storiesForEvent(slug: string): Story[] {
    return this.publicStories.filter((s) => s.eventSlug === slug);
  }

  // =========================================================================
  // CITY STATE
  // =========================================================================

  nextEventInCity(slug: string, now: Date = new Date()): CommunityEvent | undefined {
    return this.upcomingEvents(now).find((e) => e.citySlug === slug);
  }

  citySignal(city: City, now: Date = new Date()): CitySignal {
    const cityAmbassadors = this.ambassadorsInCity(city.slug);
    const cityEvents = this.eventsInCity(city.slug);
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
      builderCount: this.buildersInCity(city.slug).length,
      projectCount: this.projectsInCity(city.slug).length,
      storyCount: this.storiesInCity(city.slug).length,
      interestCount,
      next: this.nextEventInCity(city.slug, now),
    };
  }

  citySignals(now: Date = new Date()): CitySignal[] {
    return this.publicCities.map((city) => this.citySignal(city, now));
  }

  citySignalsRanked(now: Date = new Date()): CitySignal[] {
    return this.citySignals(now).sort(
      (a, b) =>
        cityStateRank(a.state) - cityStateRank(b.state) || a.city.name.localeCompare(b.city.name),
    );
  }

  citiesInState(state: CityState, now: Date = new Date()): CitySignal[] {
    return this.citySignals(now).filter((s) => s.state === state);
  }

  // =========================================================================
  // NATIONAL SIGNAL
  // =========================================================================

  nationalSignal(now: Date = new Date()): NationalSignal {
    const signals = this.citySignals(now);
    const reported = this.publicCities.filter((c) => c.reported);
    const members = reported.reduce((sum, c) => sum + (c.reported?.members ?? 0), 0);

    return {
      eventsHeld: this.pastEvents(now).length,
      eventsScheduled: this.upcomingEvents(now).length,
      citiesPlotted: signals.length,
      citiesAmbassadorLed: signals.filter((s) => s.state === 'ambassador-led').length,
      citiesWithActivity: signals.filter((s) => s.state === 'event-activity').length,
      citiesWithInterest: signals.filter((s) => s.state === 'community-interest').length,
      builders: this.publicBuilders.length,
      projects: this.publicProjects.length,
      stories: this.publicStories.length,
      useCases: this.publicUseCases.length,
      guides: this.publicGuides.length,
      ambassadors: this.publicAmbassadors.length,
      reportedMembers: members > 0 ? members : undefined,
      reportedSources: reported.map((c) => c.reported!.source),
    };
  }

  // =========================================================================
  // THE COMMUNITY FEED
  // =========================================================================

  private assembleSignals(now: Date): { scheduled: SignalItem[]; recent: SignalItem[] } {
    const scheduled: SignalItem[] = this.upcomingEvents(now).map((event) => ({
      kind: 'event-scheduled',
      date: event.date,
      subject: event.title,
      action: 'on the calendar',
      citySlug: event.citySlug,
      href: `/events/${event.slug}`,
    }));

    const held: SignalItem[] = this.pastEvents(now).map((event) => ({
      kind: 'event-held',
      date: event.date,
      subject: event.title,
      action: 'held',
      citySlug: event.citySlug,
      href: `/events/${event.slug}`,
    }));

    const joined: SignalItem[] = this.publicBuilders
      .filter((b) => b.createdAt)
      .map((b) => ({
        kind: 'builder-published',
        date: b.createdAt!,
        subject: b.name,
        action: 'joined the index',
        citySlug: b.citySlug,
        href: `/builders/${b.slug}`,
      }));

    const shipped: SignalItem[] = this.publicProjects
      .filter((p) => p.createdAt)
      .map((p) => ({
        kind: 'project-published',
        date: p.createdAt!,
        subject: p.title,
        action: 'added to the archive',
        citySlug: p.citySlug,
        href: `/projects/${p.slug}`,
      }));

    const written: SignalItem[] = this.publicStories.map((s) => ({
      kind: 'story-published',
      date: s.date,
      subject: s.title,
      action: 'published',
      citySlug: s.citySlug,
      href: `/stories/${s.slug}`,
    }));

    const documented: SignalItem[] = this.publicUseCases.map((u) => ({
      kind: 'use-case-published',
      date: u.date,
      subject: u.title,
      action: 'written up',
      citySlug: u.citySlug,
      href: `/use-cases/${u.slug}`,
    }));

    const explained: SignalItem[] = this.publicGuides.map((g) => ({
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

  communitySignal(limit = 6, now: Date = new Date()): SignalItem[] {
    const { scheduled, recent } = this.assembleSignals(now);
    return [...scheduled, ...recent].slice(0, limit);
  }

  // =========================================================================
  // COMMUNITY MEMORY
  // =========================================================================

  timeline(now: Date = new Date()): TimelineMonth[] {
    const { scheduled, recent } = this.assembleSignals(now);
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

  photoRecord(): PhotoRecordItem[] {
    const out: PhotoRecordItem[] = [];
    const withPhotos = [...this.eventsChronological].reverse().filter((e) => e.photos?.length);

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
}
