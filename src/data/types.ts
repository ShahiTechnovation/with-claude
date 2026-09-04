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
  /**
   * People who ran the room alongside the Ambassador. Must resolve against
   * `builders`, so a co-host credit always leads somewhere.
   *
   * Separate from `speakerSlugs`, which is who talked. Someone can do both,
   * and several people here did — but hosting a room and presenting in one
   * are different contributions and the record should not merge them.
   */
  builderSlugs?: string[];
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
  | 'story-published'
  | 'use-case-published'
  | 'guide-published';

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

// =========================================================================
// AUTHORSHIP — who made this, and why they would know
// =========================================================================

/**
 * The byline on anything the community writes.
 *
 * `builderSlug` is preferred: it resolves to a real profile and pulls the
 * whole graph in behind the name. `credential` answers "why do they know
 * this?" and is required, because an unattributed workflow is indistinguishable
 * from a generated one — which is the exact thing this library exists not to be.
 *
 * Never write a credential you cannot point at. "Ran the Claude Code workshop
 * in Bhopal, vol. 09" is a credential. "AI expert" is not.
 */
export interface Authorship {
  /** Resolves against `builders`. Set this rather than a bare name where possible. */
  builderSlug?: string;
  /** Falls back to this when the author has no builder entry yet. */
  name?: string;
  /** Why this person is the one telling you. Required — no anonymous authority. */
  credential: string;
}

/** An external fact leaned on. Cited so a reader can check it themselves. */
export interface Source {
  label: string;
  url?: string;
  /** When it was checked, for anything that can go stale. */
  retrieved?: IsoDate;
}

// =========================================================================
// USE CASES — Claude in practice
// =========================================================================

export type UseCaseCategory =
  | 'claude-code'
  | 'product'
  | 'startups'
  | 'research'
  | 'design'
  | 'education'
  | 'operations'
  | 'marketing'
  | 'automation'
  | 'agents'
  | 'developer-workflows';

/** One step of a real workflow, in the order it actually happened. */
export interface WorkflowStep {
  title: string;
  detail: string;
  /** Who did this step. The split is the whole point of the record. */
  by: 'human' | 'claude' | 'both';
}

/**
 * How one named person actually uses Claude.
 *
 * This is the site's knowledge library, and its value is entirely in the word
 * *actually*. A use case is a first-hand account by an attributable person
 * working on a real problem — not a listicle, not a tips post, and not a
 * summary of documentation.
 *
 * Two fields carry the honesty of the whole entity:
 *
 *  · `claudeDid` / `humanDid` are separate and both required. A record that
 *    cannot say what the person contributed is a product demo, not a workflow.
 *  · `author.credential` says why they would know.
 *
 * The title test: "How a Bhopal builder uses Claude Code to prototype
 * products" is a use case. "10 best Claude Code tips" is not, and does not
 * belong in this file.
 */
export interface UseCase extends RecordBase {
  title: string;
  /** One sentence, used on cards and as the meta description. */
  summary: string;
  category: UseCaseCategory;
  author: Authorship;
  citySlug?: string;
  date: IsoDate;
  /** The real problem being solved. Not a hypothetical. */
  problem: string;
  /** The situation it was solved in — team, constraints, stakes. */
  context: string;
  /** The workflow, in order. */
  workflow: WorkflowStep[];
  /** What Claude did. Specific, not "helped". */
  claudeDid: string[];
  /** What the person did. Judgement, verification, the parts Claude got wrong. */
  humanDid: string[];
  /** Claude surfaces and other tooling used, e.g. `Claude Code`. */
  tools: string[];
  /** A prompt or artefact, only where the author has approved sharing it. */
  artifacts?: { label: string; body: string }[];
  /** What actually came out of it. Honest about limits. */
  result: string;
  image?: string;
  projectSlug?: string;
  eventSlug?: string;
  sources?: Source[];
}

// =========================================================================
// GUIDES — written by people who did the thing
// =========================================================================

/**
 * A practical guide.
 *
 * A guide exists because a person has a real question, never because a
 * keyword does. Every one carries an author with a credential, a modified
 * date, and its sources — so a reader can weigh it, and so the page is
 * something a search engine can attribute rather than a page of text.
 */
export interface Guide extends RecordBase {
  title: string;
  /** The question this answers, in the words someone would actually ask. */
  question: string;
  standfirst: string;
  author: Authorship;
  published: IsoDate;
  /** Set whenever the body changes materially. Rendered, and in the JSON-LD. */
  modified?: IsoDate;
  readingMinutes?: number;
  image?: string;
  /** Body paragraphs and headings, in order. */
  body?: { heading?: string; paragraphs: string[] }[];
  sources?: Source[];
  builderSlugs?: string[];
  projectSlugs?: string[];
  eventSlugs?: string[];
  useCaseSlugs?: string[];
}

// =========================================================================
// BUILD DROPS — architected, not built
// =========================================================================

/**
 * A first-person publication about one thing someone shipped.
 *
 * Deliberately typed and deliberately unrouted. There is no `/drops` page and
 * there should not be one until the community is producing these — a feed
 * with three entries in it reads as an abandoned feed, and the project
 * archive already carries the same facts with less ceremony.
 *
 * What this reserves is the *shape*, so the first real drop does not force a
 * schema argument. A drop is a `Project` plus a narrative and a number.
 */
export interface BuildDrop extends RecordBase {
  /** Sequential within the series. `41` renders as `BUILD DROP #041`. */
  number: number;
  title: string;
  builderSlug: string;
  citySlug: string;
  date: IsoDate;
  /** What I built. */
  what: string;
  /** The problem. */
  problem: string;
  /** The build. */
  build: string;
  /** How Claude helped — the same honesty rule as `UseCase`. */
  claudeHelp: string;
  demoUrl?: string;
  repoUrl?: string;
  projectSlug?: string;
}
