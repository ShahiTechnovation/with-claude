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
import { records } from './dataset';
import { RecordSelectors, type BuilderAttribution, type CitySignal, type NationalSignal, type TimelineMonth, type PhotoRecordItem } from './selectors';
import type { LeaderboardWindow, LeaderboardEntry } from '@/lib/leaderboard';

export * from './site';
export type * from './types';
export { activeSource } from './dataset';
export type { DataSourceName, RecordSet } from './source';
export { RecordSelectors } from './selectors';

let _staticSelectors: RecordSelectors | undefined;

/** The build-time singleton for SSG compatibility. */
export function getStatic(): RecordSelectors {
  if (!_staticSelectors) {
    _staticSelectors = new RecordSelectors(records());
  }
  return _staticSelectors;
}

/** TEST ONLY: Reset the static selectors so equivalence tests can swap the dataset. */
export function __resetStaticSelectors(): void {
  _staticSelectors = undefined;
}

function listProxy<T>(read: () => T[]): ProxyHandler<T[]> {
  return {
    get(_target, property, receiver) {
      const list = read();
      const value = Reflect.get(list, property, receiver);
      return typeof value === 'function' ? value.bind(list) : value;
    },
    has: (_target, property) => Reflect.has(read(), property),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(read(), property),
    getPrototypeOf: () => Array.prototype,
  };
}

function mapProxy<K, V>(read: () => Map<K, V>): ProxyHandler<Map<K, V>> {
  return {
    get(_target, property, receiver) {
      const map = read();
      const value = Reflect.get(map, property, receiver);
      return typeof value === 'function' ? value.bind(map) : value;
    },
    has: (_target, property) => Reflect.has(read(), property),
    getPrototypeOf: () => Map.prototype,
  };
}

// -------------------------------------------------------------------------
// COLLECTIONS (exported as Proxies to look like arrays/maps)
// -------------------------------------------------------------------------
export const ambassadors: Ambassador[] = new Proxy([] as Ambassador[], listProxy(() => getStatic().ambassadors));
export const builders: Builder[] = new Proxy([] as Builder[], listProxy(() => getStatic().builders));
export const cities: City[] = new Proxy([] as City[], listProxy(() => getStatic().cities));
export const events: CommunityEvent[] = new Proxy([] as CommunityEvent[], listProxy(() => getStatic().events));
export const guides: Guide[] = new Proxy([] as Guide[], listProxy(() => getStatic().guides));
export const projects: Project[] = new Proxy([] as Project[], listProxy(() => getStatic().projects));
export const stories: Story[] = new Proxy([] as Story[], listProxy(() => getStatic().stories));
export const useCases: UseCase[] = new Proxy([] as UseCase[], listProxy(() => getStatic().useCases));

export const publicAmbassadors: Ambassador[] = new Proxy([] as Ambassador[], listProxy(() => getStatic().publicAmbassadors));
export const publicBuilders: Builder[] = new Proxy([] as Builder[], listProxy(() => getStatic().publicBuilders));
export const publicProjects: Project[] = new Proxy([] as Project[], listProxy(() => getStatic().publicProjects));
export const publicStories: Story[] = new Proxy([] as Story[], listProxy(() => getStatic().publicStories));
export const publicEvents: CommunityEvent[] = new Proxy([] as CommunityEvent[], listProxy(() => getStatic().publicEvents));
export const publicCities: City[] = new Proxy([] as City[], listProxy(() => getStatic().publicCities));
export const publicUseCases: UseCase[] = new Proxy([] as UseCase[], listProxy(() => getStatic().publicUseCases));
export const publicGuides: Guide[] = new Proxy([] as Guide[], listProxy(() => getStatic().publicGuides));
export const eventsChronological: CommunityEvent[] = new Proxy([] as CommunityEvent[], listProxy(() => getStatic().eventsChronological));

export const cityBySlug: Map<string, City> = new Proxy(new Map(), mapProxy(() => getStatic().cityBySlug));
export const eventBySlug: Map<string, CommunityEvent> = new Proxy(new Map(), mapProxy(() => getStatic().eventBySlug));
export const builderBySlug: Map<string, Builder> = new Proxy(new Map(), mapProxy(() => getStatic().builderBySlug));
export const projectBySlug: Map<string, Project> = new Proxy(new Map(), mapProxy(() => getStatic().projectBySlug));
export const storyBySlug: Map<string, Story> = new Proxy(new Map(), mapProxy(() => getStatic().storyBySlug));
export const ambassadorBySlug: Map<string, Ambassador> = new Proxy(new Map(), mapProxy(() => getStatic().ambassadorBySlug));
export const useCaseBySlug: Map<string, UseCase> = new Proxy(new Map(), mapProxy(() => getStatic().useCaseBySlug));
export const guideBySlug: Map<string, Guide> = new Proxy(new Map(), mapProxy(() => getStatic().guideBySlug));

// -------------------------------------------------------------------------
// EXPLICIT WRAPPER FUNCTIONS
// -------------------------------------------------------------------------
export function isPublic(record: { status: ModerationStatus }): boolean {
  return record.status === 'published' || record.status === 'featured';
}

export function upcomingEvents(now?: Date) { return getStatic().upcomingEvents(now); }
export function pastEvents(now?: Date) { return getStatic().pastEvents(now); }
export function nextEvent(now?: Date) { return getStatic().nextEvent(now); }
export function liveEvents(now?: Date) { return getStatic().liveEvents(now); }

export function getCity(slug: string) { return getStatic().getCity(slug); }
export function cityName(slug: string) { return getStatic().cityName(slug); }

export function ambassadorsInCity(slug: string) { return getStatic().ambassadorsInCity(slug); }
export function hostAmbassador(event: CommunityEvent) { return getStatic().hostAmbassador(event); }
export function isAmbassadorLed(event: CommunityEvent) { return getStatic().isAmbassadorLed(event); }
export function coHostsOf(event: CommunityEvent) { return getStatic().coHostsOf(event); }
export function creditsFor(event: CommunityEvent) { return getStatic().creditsFor(event); }
export function venueLabel(event: CommunityEvent) { return getStatic().venueLabel(event); }
export function eventsHostedBy(ambassadorSlug: string) { return getStatic().eventsHostedBy(ambassadorSlug); }
export function activityLeaderboard(options?: { window?: LeaderboardWindow; now?: Date }) { return getStatic().activityLeaderboard(options); }
export function ambassadorStanding(slug: string, now?: Date) { return getStatic().ambassadorStanding(slug, now); }
export function eventCredits(event: CommunityEvent) { return getStatic().eventCredits(event); }
export function builderForAmbassador(ambassador: Ambassador) { return getStatic().builderForAmbassador(ambassador); }
export function ambassadorForBuilder(builder: Builder) { return getStatic().ambassadorForBuilder(builder); }
export function eventsInCity(slug: string) { return getStatic().eventsInCity(slug); }
export function buildersInCity(slug: string) { return getStatic().buildersInCity(slug); }
export function projectsInCity(slug: string) { return getStatic().projectsInCity(slug); }
export function storiesInCity(slug: string) { return getStatic().storiesInCity(slug); }
export function speakersOf(event: CommunityEvent) { return getStatic().speakersOf(event); }
export function projectsFromEvent(slug: string) { return getStatic().projectsFromEvent(slug); }
export function buildersOf(project: Project) { return getStatic().buildersOf(project); }
export function builderNamesOf(project: Project) { return getStatic().builderNamesOf(project); }
export function projectsOf(builder: Builder) { return getStatic().projectsOf(builder); }
export function eventsOf(builder: Builder) { return getStatic().eventsOf(builder); }

export function useCasesChronological() { return getStatic().useCasesChronological(); }
export function guidesChronological() { return getStatic().guidesChronological(); }
export function authorOf(record: { author: Authorship }) { return getStatic().authorOf(record); }
export function authorName(record: { author: Authorship }) { return getStatic().authorName(record); }
export function useCasesInCity(slug: string) { return getStatic().useCasesInCity(slug); }
export function useCasesBy(builderSlug: string) { return getStatic().useCasesBy(builderSlug); }
export function guidesBy(builderSlug: string) { return getStatic().guidesBy(builderSlug); }
export function useCasesForProject(slug: string) { return getStatic().useCasesForProject(slug); }
export function useCasesForEvent(slug: string) { return getStatic().useCasesForEvent(slug); }
export function guidesForEvent(slug: string) { return getStatic().guidesForEvent(slug); }
export function claudeSurfaces() { return getStatic().claudeSurfaces(); }
export function storiesChronological() { return getStatic().storiesChronological(); }
export function storiesForEvent(slug: string) { return getStatic().storiesForEvent(slug); }

export function nextEventInCity(slug: string, now?: Date) { return getStatic().nextEventInCity(slug, now); }
export function citySignal(city: City, now?: Date) { return getStatic().citySignal(city, now); }
export function citySignals(now?: Date) { return getStatic().citySignals(now); }
export function citySignalsRanked(now?: Date) { return getStatic().citySignalsRanked(now); }
export function citiesInState(state: CityState, now?: Date) { return getStatic().citiesInState(state, now); }

export function nationalSignal(now?: Date) { return getStatic().nationalSignal(now); }
export function communitySignal(limit?: number, now?: Date) { return getStatic().communitySignal(limit, now); }
export function timeline(now?: Date) { return getStatic().timeline(now); }
export function photoRecord() { return getStatic().photoRecord(); }
