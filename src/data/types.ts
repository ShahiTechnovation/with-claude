/**
 * WITH CLAUDE — domain model.
 *
 * Everything the site renders derives from these types. No page hard-codes an
 * event, a date, a count or a community status; the selectors in
 * `src/data/index.ts` and the helpers in `src/lib/` compute them.
 *
 * Three governance rules are enforced by the shape of these types:
 *
 *  1. Only a verified Claude Community Ambassador can host an event that gets
 *     the site's strongest treatment. See `Ambassador` and `EventHost`.
 *  2. Anyone can be listed as a builder, but every submission carries a
 *     moderation state and starts at `pending`. See `ModerationStatus`.
 *  3. A city's community state is DERIVED from verified records. There is no
 *     field a well-meaning editor can set to make a chapter appear.
 */

/** ISO-8601 calendar date, `YYYY-MM-DD`. */
export type IsoDate = `${number}-${number}-${number}`;
/** 24-hour clock, `HH:MM`, always India Standard Time. */
export type ClockTime = `${number}:${number}`;

/**
 * Where a submitted record sits in review.
 *
 * Nothing a person submits is published by writing it here — `pending` is the
 * only value a submission may enter with, and a human moves it on.
 */
export type ModerationStatus = 'pending' | 'published' | 'featured' | 'archived';

/**
 * Every entity in the record carries these. `createdAt`/`updatedAt` are
 * optional on purpose: they are only set when the real date is known. A guessed
 * timestamp would surface in the activity feed as invented activity, so an
 * unknown date is left out rather than filled in.
 */
export interface RecordBase {
  id: string;
  slug: string;
  status: ModerationStatus;
  createdAt?: IsoDate;
  updatedAt?: IsoDate;
}

export interface SocialLink {
  label: string;
  url: string;
}

// =========================================================================
// AMBASSADORS — the only verified hosting role
// =========================================================================

/**
 * A Claude Community Ambassador.
 *
 * Ambassador status is granted by Anthropic, never by this website. A record
 * here is a statement that someone's status has been confirmed, which is why
 * `verifiedVia` is required rather than optional: if you cannot say how you
 * know, there is no record to write.
 */
export interface Ambassador extends RecordBase {
  name: string;
  citySlug: string;
  /** The programme title, verbatim. Do not paraphrase it. */
  title: 'Claude Community Ambassador';
  /** How the status was confirmed. Required — no unattributed ambassadors. */
  verifiedVia: string;
  /** Links this ambassador to their entry in the builder directory. */
  builderSlug?: string;
  since?: IsoDate;
  bio?: string;
  image?: string;
  links?: SocialLink[];
}

// =========================================================================
// EVENTS
// =========================================================================

/**
 * The lifecycle of an event, derived from the clock. Never authored, never
 * stored — see `lifecycleOf()` in `src/lib/status.ts`.
 */
export type EventLifecycle =
  'upcoming' | 'today' | 'live' | 'sold-out' | 'registration-closed' | 'past' | 'cancelled';

/** Author-supplied door states. Everything else is computed. */
export type EventOverride = 'sold-out' | 'registration-closed' | 'cancelled';

export type EventFormat =
  'conversation' | 'workshop' | 'impact-lab' | 'campus' | 'hackathon' | 'demo' | 'meetup' | 'other';

export interface Venue {
  /** Public venue name, or the honest stand-in when it is shared privately. */
  name: string;
  address?: string;
  /** True when the venue is only shared with confirmed registrants. */
  private?: boolean;
}

export interface EventPhoto {
  /** Path relative to `src/assets`, resolved by the image registry. */
  src: string;
  alt: string;
}

export interface AgendaItem {
  /** Wall-clock start, IST. Omit for an unscheduled block. */
  time?: ClockTime;
  title: string;
  detail?: string;
}

/**
 * Who is running an event.
 *
 * `ambassadorSlug` is the load-bearing field. An event with a resolvable,
 * published ambassador is an Ambassador-led Claude Community event and gets
 * the verified treatment. An event without one is community activity, and the
 * UI must say so plainly.
 */
export interface EventHost {
  ambassadorSlug?: string;
  /** Organisations hosting, co-hosting, or lending the room. */
  organisations?: string[];
}

export interface CommunityEvent extends RecordBase {
  /** Title without the city prefix — the city renders separately. */
  title: string;
  format: EventFormat;
  /** Volume number within its city's series, e.g. 7 renders as `vol. 07`. */
  volume?: number;
  citySlug: string;
  host: EventHost;
  date: IsoDate;
  startTime: ClockTime;
  endTime?: ClockTime;
  venue: Venue;
  /** One sentence. Used on cards and as the meta description. */
  summary: string;
  description?: string;
  registrationUrl?: string;
  /** Set only when the door state differs from what the clock implies. */
  statusOverride?: EventOverride;
  free: boolean;
  coverImage?: string;
  photos?: EventPhoto[];
  /** Builder slugs who spoke. Must resolve against `builders`. */
  speakerSlugs?: string[];
  agenda?: AgendaItem[];
  /** Verified, quotable facts about what happened. Shown on past events. */
  outcomes?: string[];
  /** Project slugs that came out of this room. */
  projectSlugs?: string[];
}

// =========================================================================
// CITIES
// =========================================================================

/**
 * What is actually happening in a city.
 *
 * DERIVED, never authored — see `cityState()` in `src/lib/city.ts`. There is
 * deliberately no `chapter` value and no way to set one: a city becomes
 * `ambassador-led` because a verified Ambassador record points at it, and no
 * other way.
 */
export type CityState =
  /** A verified Claude Community Ambassador is hosting here. */
  | 'ambassador-led'
  /** Events are on the record, but no Ambassador is currently assigned. */
  | 'event-activity'
  /** People have registered interest. Nothing has happened yet. */
  | 'community-interest'
  /** Plotted so the map shows the country. No verified activity. */
  | 'discovery';

export interface City extends RecordBase {
  name: string;
  state: string;
  /** Real decimal coordinates. Drives every map position on the site. */
  lat: number;
  lon: number;
  /**
   * One line about the city itself. For cities with no activity this is
   * geography or context — never an implied promise that something is coming.
   */
  blurb: string;
  /**
   * Interest registered by people who live there. Only ever set from a real
   * count with a real source; an unknown signal is left undefined.
   */
  interest?: { count: number; source: string };
  /** Community-reported figures. Always rendered with their attribution. */
  reported?: {
    members?: number;
    prototypes?: number;
    /** Where the figure came from, so it can be re-verified. */
    source: string;
  };
  /** Organisation running community activity locally, where one exists. */
  organiser?: { name: string; url?: string };
  image?: string;
  links?: SocialLink[];
}

// =========================================================================
// BUILDERS
// =========================================================================

/**
 * What someone does in the community.
 *
 * `ambassador` is not self-assignable: the UI only renders it for a builder
 * whose slug is claimed by a published `Ambassador` record, so putting it here
 * by hand achieves nothing.
 */
export type BuilderRole =
  'ambassador' | 'host' | 'speaker' | 'contributor' | 'builder' | 'volunteer';

export interface Builder extends RecordBase {
  name: string;
  citySlug: string;
  /** What they do, in three or four words. */
  role: string;
  roles: BuilderRole[];
  bio?: string;
  /** What they are building right now, in one line. */
  building?: string;
  /** Which Claude tools they actually use. Free text, kept short. */
  claudeTools?: string[];
  image?: string;
  links?: SocialLink[];
  projectSlugs?: string[];
  /** Event slugs they spoke at, mentored, or organised. */
  eventSlugs?: string[];
}

// =========================================================================
// PROJECTS
// =========================================================================

export type ProjectCategory =
  | 'product'
  | 'agent'
  | 'developer-tool'
  | 'research'
  | 'creative'
  | 'campus'
  | 'experiment'
  | 'startup';

export interface Project extends RecordBase {
  title: string;
  /** Builder slugs. Must resolve against `builders`. */
  builderSlugs: string[];
  citySlug: string;
  summary: string;
  description?: string;
  category: ProjectCategory;
  url?: string;
  repoUrl?: string;
  videoUrl?: string;
  image?: string;
  tags?: string[];
  /** How Claude was actually used — the interesting part of the record. */
  claudeUsage?: string;
  /** Event slug it was built at, if it came out of a build day. */
  builtAtEventSlug?: string;
}

// =========================================================================
// STORIES
// =========================================================================

export type StoryKind =
  'recap' | 'profile' | 'project-story' | 'city-story' | 'photo-essay' | 'lesson' | 'experiment';

export interface Story extends RecordBase {
  title: string;
  standfirst: string;
  kind: StoryKind;
  date: IsoDate;
  citySlug?: string;
  author?: string;
  image?: string;
  /** Event slug this story documents, if any. */
  eventSlug?: string;
  /** Builder slugs the story is about. */
  builderSlugs?: string[];
  readingMinutes?: number;
  /** Body paragraphs. A photo essay may have none. */
  body?: string[];
}

// =========================================================================
// SUPPORTING RECORDS
// =========================================================================

export interface Partner extends RecordBase {
  name: string;
  /** How they actually help — no vague "supported by". */
  role: string;
  url?: string;
  citySlug?: string;
}

export interface FaqItem {
  q: string;
  a: string;
}

/** How a participation path routes someone onward. */
export type PathKind =
  /** Somewhere on this site. */
  | 'internal'
  /** A real external form or channel. */
  | 'external'
  /** Anthropic's own programme. This site never grants the status. */
  | 'official'
  /** A compose-and-send submission handled by `SubmitPanel`. */
  | 'submission';

export interface ParticipationPath {
  id: string;
  label: string;
  title: string;
  description: string;
  ctaLabel: string;
  kind: PathKind;
  /** Where the CTA goes. Undefined only for `submission` paths. */
  url?: string;
  /** Tally form id, when the CTA can open a Tally popup. */
  tallyId?: string;
  /** Submission form id, for `submission` paths. */
  formId?: string;
  /** Rendered as a caveat under the CTA. Used for the Ambassador path. */
  note?: string;
}

// =========================================================================
// DERIVED — the activity feed
// =========================================================================

export type SignalKind =
  | 'event-scheduled'
  | 'event-held'
  | 'ambassador-verified'
  | 'builder-published'
  | 'project-published'
  | 'story-published';

/**
 * One line in the community feed. Every item is built from a record with a
 * real date — nothing here is authored, so nothing here can be invented.
 */
export interface SignalItem {
  kind: SignalKind;
  date: IsoDate;
  /** The subject, e.g. an event title or a person's name. */
  subject: string;
  /** The verb phrase, e.g. `on the calendar`. */
  action: string;
  citySlug?: string;
  href?: string;
}
