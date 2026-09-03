/**
 * Claude India — domain model.
 *
 * Everything the site renders derives from these types. No page hard-codes an
 * event, a date, or a count; selectors in `src/data/index.ts` compute them.
 */

/** ISO-8601 calendar date, `YYYY-MM-DD`. */
export type IsoDate = `${number}-${number}-${number}`;
/** 24-hour clock, `HH:MM`, always India Standard Time. */
export type ClockTime = `${number}:${number}`;

/** Lifecycle of an event, derived from its data — never authored by hand. */
export type EventStatus =
  'upcoming' | 'today' | 'live' | 'sold-out' | 'registration-closed' | 'past' | 'cancelled';

/** Author-supplied overrides. Anything else is computed from the clock. */
export type EventOverride = 'sold-out' | 'registration-closed' | 'cancelled';

export type EventFormat = 'workshop' | 'conversation' | 'impact-lab' | 'meetup' | 'campus';

export interface Venue {
  /** Public venue name, or the honest stand-in when it is shared privately. */
  name: string;
  /** Street / locality line. Omit when the venue is not yet public. */
  address?: string;
  /** True when the venue is only shared with confirmed registrants. */
  private?: boolean;
}

export interface EventPhoto {
  /** Import path relative to `src/assets`, resolved by the image registry. */
  src: string;
  alt: string;
}

export interface CommunityEvent {
  id: string;
  slug: string;
  /** Title without the city prefix — the city renders separately. */
  title: string;
  format: EventFormat;
  /** Chapter volume number, e.g. 7 renders as `vol. 07`. */
  volume?: number;
  citySlug: string;
  date: IsoDate;
  startTime: ClockTime;
  endTime?: ClockTime;
  venue: Venue;
  /** One sentence. Used on cards and as the meta description on detail pages. */
  summary: string;
  /** Longer copy for the detail page. Optional. */
  description?: string;
  registrationUrl?: string;
  /** Set only when the door state differs from what the clock implies. */
  statusOverride?: EventOverride;
  free: boolean;
  coverImage?: string;
  photos?: EventPhoto[];
  /** Builder slugs who spoke. Must resolve against `builders`. */
  speakerSlugs?: string[];
  /** Organisation names hosting or co-hosting. */
  hosts?: string[];
  /** Verified, quotable facts about what happened. Shown on past events. */
  outcomes?: string[];
}

/** How far along a city is. Only `active` cities have run events. */
export type CityStatus = 'active' | 'forming' | 'open';

export interface City {
  id: string;
  slug: string;
  name: string;
  state: string;
  /** Real decimal coordinates. Drives every map position on the site. */
  lat: number;
  lon: number;
  status: CityStatus;
  /** One line. For `open` cities this is an invitation, not a claim. */
  blurb: string;
  /** Chapter-reported figures. Only ever set on `active` cities. */
  reported?: {
    members?: number;
    prototypes?: number;
    /** Where the figure came from, so it can be re-verified. */
    source: string;
  };
  organiser?: { name: string; url?: string };
  image?: string;
  links?: SocialLink[];
}

export interface SocialLink {
  label: string;
  url: string;
}

export interface Builder {
  id: string;
  slug: string;
  name: string;
  citySlug: string;
  /** What they do, in three or four words. */
  role: string;
  bio?: string;
  image?: string;
  links?: SocialLink[];
  projectSlugs?: string[];
  /** Event slugs they spoke at, mentored or organised. */
  eventSlugs?: string[];
}

export interface Project {
  id: string;
  slug: string;
  title: string;
  /** Builder slugs. Must resolve against `builders`. */
  builderSlugs: string[];
  citySlug: string;
  summary: string;
  url?: string;
  repoUrl?: string;
  image?: string;
  tags?: string[];
  /** How Claude was actually used — the interesting part of the record. */
  claudeUsage?: string;
  /** Event slug it was built at, if it came out of a build day. */
  builtAtEventSlug?: string;
}

export interface Story {
  id: string;
  slug: string;
  title: string;
  standfirst: string;
  date: IsoDate;
  citySlug?: string;
  author?: string;
  image?: string;
  /** Event slug this story documents, if any. */
  eventSlug?: string;
  readingMinutes?: number;
}

export interface Partner {
  id: string;
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

/** A way to take part. Drives the participation section and its forms. */
export interface Involvement {
  id: string;
  label: string;
  title: string;
  description: string;
  ctaLabel: string;
  url: string;
  /** Tally form id, when the CTA opens a Tally popup. */
  tallyId?: string;
}
