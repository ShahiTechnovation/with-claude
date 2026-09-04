/**
 * WITH CLAUDE — the database schema.
 *
 * This is the Phase 1 foundation. The public site still renders from
 * `src/data/*.ts`; nothing here is read at build time yet. What this file does
 * is carry the governance rules that are currently enforced only by TypeScript
 * shape and code review into constraints a database will refuse to break.
 *
 * The five rules that drove the design, and where each one lives:
 *
 *  1. A CITY'S STATE IS DERIVED. There is no `city_state`, no `chapter`, no
 *     `is_active`. A city becomes ambassador-led because a verified ambassador
 *     row points at it, and no other way. Nothing in `cities` can be edited to
 *     fake that.
 *
 *  2. AN EVENT'S LIFECYCLE IS THE CLOCK. There is no `upcoming` / `today` /
 *     `live` / `past` column. Only `status_override`, for the three door
 *     states a clock genuinely cannot know.
 *
 *  3. AMBASSADOR STATUS IS NOT SELF-ASSIGNABLE. `builders.roles` carries a
 *     CHECK that rejects the literal `ambassador`, and `ambassadors` requires
 *     `verified_via` — if you cannot say how you know, there is no row.
 *
 *  4. AUTHORITY IS ATTRIBUTED. Every byline carries a non-null credential, and
 *     every piece of media carries non-null alt text.
 *
 *  5. A NUMBER HAS A SOURCE. Community-reported figures are only storable
 *     alongside their attribution — enforced by CHECK, not by convention.
 *
 * Moderation uses the audited eight-state vocabulary. `featured` is a separate
 * boolean rather than a ninth state, because being featured is a display
 * decision and being published is a review decision, and folding them together
 * is what made the original four-value enum lossy.
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// =========================================================================
// ENUMS
// =========================================================================

/**
 * Where a record sits in review. The audited vocabulary, in the order a piece
 * of work actually moves through it.
 *
 * Note what is not here: `featured`. See the file header.
 */
export const contentStatus = pgEnum('content_status', [
  'draft',
  'pending',
  'in_review',
  'changes_requested',
  'approved',
  'published',
  'rejected',
  'archived',
]);

/**
 * Author-supplied door states — and ONLY door states.
 *
 * `upcoming`, `today`, `live` and `past` are deliberately absent. They are
 * functions of the current time, computed by `lifecycleOf()`, and storing them
 * would create a second answer to a question that already has one.
 */
export const eventStatusOverride = pgEnum('event_status_override', [
  'sold-out',
  'registration-closed',
  'cancelled',
]);

export const eventFormat = pgEnum('event_format', [
  'conversation',
  'workshop',
  'impact-lab',
  'campus',
  'hackathon',
  'demo',
  'meetup',
  'other',
]);

export const projectCategory = pgEnum('project_category', [
  'product',
  'agent',
  'developer-tool',
  'research',
  'creative',
  'campus',
  'experiment',
  'startup',
]);

export const storyKind = pgEnum('story_kind', [
  'recap',
  'profile',
  'project-story',
  'city-story',
  'photo-essay',
  'lesson',
  'experiment',
]);

export const useCaseCategory = pgEnum('use_case_category', [
  'claude-code',
  'product',
  'startups',
  'research',
  'design',
  'education',
  'operations',
  'marketing',
  'automation',
  'agents',
  'developer-workflows',
]);

/** Who did a step of a documented workflow. The split is the point. */
export const workflowActor = pgEnum('workflow_actor', ['human', 'claude', 'both']);

/** What kind of thing someone sent in. One per public submission form. */
export const submissionKind = pgEnum('submission_kind', [
  'builder',
  'project',
  'use-case',
  'city-interest',
]);

/**
 * Where an inbox item sits.
 *
 * Separate from `content_status` on purpose: a submission is not a draft of a
 * record, it is a message about one. The values are the audited review
 * workflow and nothing else —
 *
 *     draft → pending → in_review ─┬→ changes_requested → pending
 *                                  ├→ approved
 *                                  └→ rejected
 *
 * `approved` deliberately stops short of `published`. Approving says a person
 * read this and it should become part of the record; publishing is a separate
 * act tied to a build, and conflating the two is how a review queue turns into
 * an accidental publishing pipeline. There is no `published` here, and there
 * should not be one until Phase 3 gives publication somewhere real to happen.
 *
 * `draft` exists for a submission an editor starts themselves. Nothing
 * arriving through `/api/submit` is ever a draft — the public endpoint writes
 * `pending`, because a person has finished writing it and is waiting.
 */
export const submissionStatus = pgEnum('submission_status', [
  'draft',
  'pending',
  'in_review',
  'changes_requested',
  'approved',
  'rejected',
]);

export const mediaKind = pgEnum('media_kind', ['photo', 'cover', 'portrait', 'logo', 'other']);

/** Reviewer capability. Not an auth system — Phase 2 owns that. */
export const userRole = pgEnum('user_role', ['viewer', 'reviewer', 'editor', 'admin']);

// =========================================================================
// PEOPLE WHO REVIEW
// =========================================================================

/**
 * Editorial accounts. The allowlist.
 *
 * There is no sign-up. A row here is created by `npm run db:create-user` and
 * by nothing else — the login form checks this table and, if there is no
 * active row, sends nothing. That is the whole access model: you cannot get an
 * account by asking the website for one.
 *
 * `active` is the off switch. It is checked on every single admin request
 * rather than only at login, so revoking someone takes effect on their next
 * click instead of whenever their session happens to expire.
 *
 * `emailVerified`, `image` and `updatedAt` are here because the auth library
 * maps its `user` model onto this table. `role` and `active` are ours, and are
 * deliberately NOT read from the session token — see `admin/src/server/auth`.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  role: userRole('role').notNull().default('viewer'),
  /** False disables the account everywhere, immediately. */
  active: boolean('active').notNull().default(true),
  /** Owned by the auth library. True once a magic link has been opened. */
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// -------------------------------------------------------------------------
// AUTHENTICATION — owned by the auth library, used only by the admin origin
// -------------------------------------------------------------------------
//
// These three tables exist for `admin.withclaude.in` and are touched by
// nothing else. The public site has no session, no cookie and no auth code:
// `tests/security.test.ts` checks its bundle for exactly that.
//
// Their ids are `text` rather than `uuid` because the auth library generates
// them, and a column that lies about what it holds is worse than one that is
// honest about being opaque. `users.id` stays a uuid because we generate it.

/**
 * An open sign-in.
 *
 * `token` is what the cookie carries. It is unique and indexed because every
 * authenticated request looks a session up by it, and it cascades on user
 * deletion so a removed account cannot leave a working session behind.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Recorded by the auth library for session management, not for analytics. */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_user_idx').on(table.userId)],
);

/**
 * A pending magic link.
 *
 * The token is stored hashed — see `storeToken: 'hashed'` where the plugin is
 * configured. A leaked database dump is then a list of expiry times rather than
 * a set of working front doors.
 */
export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

/**
 * Credentials from an identity provider.
 *
 * Empty in Phase 2 and expected to stay that way: the only sign-in method is a
 * magic link, which writes to `verifications`, not here. The table exists
 * because the auth library's schema includes it, and because adding a provider
 * later should be a configuration change rather than a migration.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('accounts_user_idx').on(table.userId)],
);

// =========================================================================
// ORGANIZATIONS — normalised out of the free-text strings in the record
// =========================================================================

/**
 * A real organisation: a co-host, a venue partner, a local organiser.
 *
 * The TypeScript record represents these three different ways — as strings in
 * `event.host.organisations`, as `{ name, url }` on a city, and as prose. They
 * are the same organisations, so they get one table and one slug.
 */
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull().unique(),
  url: text('url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// =========================================================================
// MEDIA — metadata only in Phase 1
// =========================================================================

/**
 * Metadata for an image that already exists in the repository.
 *
 * Phase 1 does not move a single byte: `path` is the path under `src/assets`
 * that the image registry already resolves, and git stays the store. R2 and
 * contributor uploads are Phase 4, at which point this table gains a bucket
 * key and stops pointing at the repo.
 *
 * `alt` is NOT NULL. An image nobody can describe is an image nobody who
 * needs a description can see, and making the column nullable is how that
 * becomes normal.
 */
export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Path relative to `src/assets`, e.g. `events/vol02-1.jpg`. */
  path: text('path').notNull().unique(),
  alt: text('alt').notNull(),
  kind: mediaKind('kind').notNull().default('other'),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// =========================================================================
// CITIES
// =========================================================================

/**
 * A city on the atlas.
 *
 * READ THE ABSENCE. There is no state, status, tier, chapter or activity
 * column here, and adding one would undo the single most important governance
 * rule on the site: a city's community state is computed from verified
 * ambassador, event and interest records, so there is nothing an editor can
 * set to make a chapter appear that is not there.
 *
 * `region` is the Indian state or union territory — geography, not lifecycle.
 * It is named `region` precisely so it can never be mistaken for the derived
 * `CityState`.
 */
export const cities = pgTable(
  'cities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    /** Indian state or union territory. Geography — never a lifecycle. */
    region: text('region').notNull(),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    blurb: text('blurb').notNull(),

    /**
     * Interest registered by people who live there, with the source of the
     * count. Both columns move together — see the CHECK below.
     */
    interestCount: integer('interest_count'),
    interestSource: text('interest_source'),

    /** Community-reported figures. Always rendered with their attribution. */
    reportedMembers: integer('reported_members'),
    reportedPrototypes: integer('reported_prototypes'),
    reportedSource: text('reported_source'),

    /** The organisation running community activity locally, where one exists. */
    organiserId: uuid('organiser_id').references(() => organizations.id, { onDelete: 'set null' }),

    imageId: uuid('image_id').references(() => media.id, { onDelete: 'set null' }),
    /**
     * A repository asset path, e.g. `city/city-01.jpg`.
     *
     * Separate from `imageId` on purpose. `media` is the table of images
     * somebody has described, and its `alt` is NOT NULL. This column is an
     * asset reference and nothing more: it carries no alt text and claims
     * none, because the pictures it points at are ones nobody wrote a
     * description for. See migration 0003 for the whole argument.
     */
    imagePath: text('image_path'),

    status: contentStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),

    /** Null when the record's real creation date is unknown. Never guessed. */
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * A REPORTED FIGURE MUST HAVE A SOURCE.
     *
     * "Bhopal: 900 members" with nobody willing to say where that came from is
     * the exact kind of number this project exists not to print. The database
     * refuses to hold one.
     */
    check(
      'cities_reported_needs_source',
      sql`(${table.reportedMembers} IS NULL AND ${table.reportedPrototypes} IS NULL)
          OR ${table.reportedSource} IS NOT NULL`,
    ),
    check(
      'cities_interest_needs_source',
      sql`${table.interestCount} IS NULL OR ${table.interestSource} IS NOT NULL`,
    ),
    check('cities_lat_range', sql`${table.lat} BETWEEN -90 AND 90`),
    check('cities_lon_range', sql`${table.lon} BETWEEN -180 AND 180`),
    index('cities_status_idx').on(table.status),
  ],
);

// =========================================================================
// BUILDERS
// =========================================================================

/**
 * Someone building with Claude.
 *
 * `roles` is free to say host, speaker, contributor, builder or volunteer. It
 * is NOT free to say `ambassador` — that is checked at the database, because
 * a self-declared ambassador is precisely the claim this site must never
 * render. The ambassador role is read off the `ambassadors` table or not at
 * all.
 *
 * `created_at` is nullable and stays null for every record imported from the
 * TypeScript files, because the repository does not know when most of these
 * people joined. An invented date would surface in the activity feed as
 * invented activity.
 */
export const builders = pgTable(
  'builders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    cityId: uuid('city_id')
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),
    /** What they do, in three or four words. */
    role: text('role').notNull(),
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    bio: text('bio'),
    building: text('building'),
    claudeTools: text('claude_tools')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    imageId: uuid('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** A repository asset path. See `cities.imagePath`. */
    imagePath: text('image_path'),
    status: contentStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * NOBODY MAKES THEMSELVES AN AMBASSADOR.
     *
     * Anthropic grants the status; this database records that it was granted,
     * in `ambassadors`, with provenance. A builder row claiming the role is
     * rejected outright rather than filtered out in a selector somebody might
     * later forget to call.
     */
    check('builders_roles_exclude_ambassador', sql`NOT (${table.roles} @> ARRAY['ambassador'])`),
    index('builders_city_idx').on(table.cityId),
    index('builders_status_idx').on(table.status),
  ],
);

// =========================================================================
// AMBASSADORS — the only verified hosting role
// =========================================================================

/**
 * A Claude Community Ambassador.
 *
 * `verified_via` is NOT NULL and non-empty. The whole value of this table is
 * that every row can answer "how do you know?" — an ambassador record without
 * provenance is indistinguishable from someone having typed their own name
 * into the strongest treatment on the site.
 */
export const ambassadors = pgTable(
  'ambassadors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    cityId: uuid('city_id')
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),
    /** The programme title, verbatim. Constrained so it cannot be paraphrased. */
    title: text('title').notNull().default('Claude Community Ambassador'),
    /** How the status was confirmed. Required — no unattributed ambassadors. */
    verifiedVia: text('verified_via').notNull(),
    /** Set when a human confirmed the provenance above. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
    /** Links this ambassador to their entry in the builder directory. */
    builderId: uuid('builder_id').references(() => builders.id, { onDelete: 'set null' }),
    since: date('since'),
    bio: text('bio'),
    imageId: uuid('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** A repository asset path. See `cities.imagePath`. */
    imagePath: text('image_path'),
    status: contentStatus('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    check('ambassadors_verified_via_present', sql`length(trim(${table.verifiedVia})) > 0`),
    check('ambassadors_title_verbatim', sql`${table.title} = 'Claude Community Ambassador'`),
    /** One ambassador record per builder. Nobody is verified twice over. */
    uniqueIndex('ambassadors_builder_unique').on(table.builderId),
    index('ambassadors_city_idx').on(table.cityId),
  ],
);

// =========================================================================
// EVENTS
// =========================================================================

/**
 * A room that happened, or is going to.
 *
 * NO LIFECYCLE COLUMN. `date` + `start_time` + `end_time` and the current
 * time are the whole answer to "is this upcoming, live or past", and
 * `lifecycleOf()` already computes it. `status_override` exists for the three
 * things the clock cannot know: the door is shut, the tickets are gone, or it
 * is off.
 *
 * `status` here is the moderation state, which is a different question with a
 * different answer — the editor, not the calendar.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    format: eventFormat('format').notNull(),
    /** Volume within its city's own series. Scoped per city, not globally. */
    volume: smallint('volume'),
    cityId: uuid('city_id')
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),

    /** The verified ambassador hosting. Null means community activity. */
    ambassadorId: uuid('ambassador_id').references(() => ambassadors.id, { onDelete: 'set null' }),

    date: date('date').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time'),

    venueName: text('venue_name').notNull(),
    venueAddress: text('venue_address'),
    /** True when the address goes to confirmed registrants only. */
    venuePrivate: boolean('venue_private').notNull().default(false),

    summary: text('summary').notNull(),
    description: text('description'),
    registrationUrl: text('registration_url'),

    /** Authored door states only. See the note above. */
    statusOverride: eventStatusOverride('status_override'),

    free: boolean('free').notNull().default(true),
    coverImageId: uuid('cover_image_id').references(() => media.id, { onDelete: 'set null' }),
    /** A repository asset path for the cover. See `cities.imagePath`. */
    coverImagePath: text('cover_image_path'),

    status: contentStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),

    /**
     * An event is the one entity whose creation date IS evidenced — by the
     * date it was held. The importer backfills it from `date` and nothing
     * else does.
     */
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    check('events_volume_positive', sql`${table.volume} IS NULL OR ${table.volume} > 0`),
    check(
      'events_end_after_start',
      sql`${table.endTime} IS NULL OR ${table.endTime} > ${table.startTime}`,
    ),
    index('events_city_idx').on(table.cityId),
    index('events_date_idx').on(table.date),
    index('events_status_idx').on(table.status),
  ],
);

/** Builders who ran a room alongside the ambassador. Separate from speaking. */
export const eventCoHosts = pgTable(
  'event_co_hosts',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    builderId: uuid('builder_id')
      .notNull()
      .references(() => builders.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.builderId] })],
);

/** Who talked. Deliberately not merged with co-hosting. */
export const eventSpeakers = pgTable(
  'event_speakers',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    builderId: uuid('builder_id')
      .notNull()
      .references(() => builders.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.builderId] })],
);

/**
 * Builders who were on the record in a room without hosting or speaking.
 *
 * The third credit, and deliberately its own table rather than a `role` column
 * on a merged one — see migration 0004. The Impact Lab cohort are all here:
 * they turned up and built something, which is a real credit and a different
 * one from having run the room or presented in it.
 */
export const eventAttendees = pgTable(
  'event_attendees',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    builderId: uuid('builder_id')
      .notNull()
      .references(() => builders.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.builderId] })],
);

/** Organisations hosting, co-hosting, or lending the room. */
export const eventOrganizations = pgTable(
  'event_organizations',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.organizationId] })],
);

export const eventAgendaItems = pgTable(
  'event_agenda_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    /** Wall-clock start, IST. Null for an unscheduled block. */
    time: time('time'),
    title: text('title').notNull(),
    detail: text('detail'),
  },
  (table) => [uniqueIndex('event_agenda_position_unique').on(table.eventId, table.position)],
);

/** Verified, quotable facts about what happened. Shown on past events. */
export const eventOutcomes = pgTable(
  'event_outcomes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    text: text('text').notNull(),
  },
  (table) => [uniqueIndex('event_outcome_position_unique').on(table.eventId, table.position)],
);

export const eventPhotos = pgTable(
  'event_photos',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    mediaId: uuid('media_id')
      .notNull()
      .references(() => media.id, { onDelete: 'restrict' }),
    position: smallint('position').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.mediaId] }),
    uniqueIndex('event_photo_position_unique').on(table.eventId, table.position),
  ],
);

// =========================================================================
// PROJECTS
// =========================================================================

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    cityId: uuid('city_id')
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),
    summary: text('summary').notNull(),
    description: text('description'),
    category: projectCategory('category').notNull(),
    url: text('url'),
    repoUrl: text('repo_url'),
    videoUrl: text('video_url'),
    imageId: uuid('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** A repository asset path. See `cities.imagePath`. */
    imagePath: text('image_path'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    /** How Claude was actually used — the interesting part of the record. */
    claudeUsage: text('claude_usage'),
    /** The build day it came out of, if any. */
    builtAtEventId: uuid('built_at_event_id').references(() => events.id, { onDelete: 'set null' }),
    /**
     * This project's index in `src/data/projects.ts`'s authored array.
     *
     * `src/data/projects.ts` is one flat list with a real, deliberate order —
     * the file's own comments say so ("Homepage preview candidates first").
     * PostgreSQL has no equivalent of "array order" for a table with no
     * `ORDER BY`, and the id column cannot substitute for one: it is a random
     * `gen_random_uuid()`, not a sequence, so ordering by it reproduces
     * nothing. `projectsInCity()` and `projectsFromEvent()` both preserve
     * whatever order they are handed, and the event page renders the latter
     * with a plain, unsorted `.map()` — so a project list's order is real,
     * rendered content, and this is what lets the database reproduce it.
     *
     * Nullable and unbackfilled: a database imported before this migration
     * simply has `NULL` here, and the reader falls back to ordering by slug
     * for any project without a position — see `src/data/source-db.ts`.
     */
    position: smallint('position'),
    status: contentStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    index('projects_city_idx').on(table.cityId),
    index('projects_event_idx').on(table.builtAtEventId),
    index('projects_status_idx').on(table.status),
  ],
);

export const projectBuilders = pgTable(
  'project_builders',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    builderId: uuid('builder_id')
      .notNull()
      .references(() => builders.id, { onDelete: 'restrict' }),
    position: smallint('position').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.builderId] })],
);

// =========================================================================
// STORIES
// =========================================================================

export const stories = pgTable(
  'stories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    standfirst: text('standfirst').notNull(),
    kind: storyKind('kind').notNull(),
    date: date('date').notNull(),
    cityId: uuid('city_id').references(() => cities.id, { onDelete: 'set null' }),
    author: text('author'),
    imageId: uuid('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** A repository asset path. See `cities.imagePath`. */
    imagePath: text('image_path'),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    readingMinutes: smallint('reading_minutes'),
    /** Body paragraphs, in order. A photo essay may have none. */
    body: text('body')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    status: contentStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [index('stories_city_idx').on(table.cityId)],
);

export const storyBuilders = pgTable(
  'story_builders',
  {
    storyId: uuid('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
    builderId: uuid('builder_id')
      .notNull()
      .references(() => builders.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.storyId, table.builderId] })],
);

// =========================================================================
// USE CASES — Claude in practice
// =========================================================================

/**
 * How one named person actually uses Claude.
 *
 * `author_credential` is NOT NULL. An unattributed workflow is
 * indistinguishable from a generated one, which is the exact thing this
 * library exists not to be — so the credential is a column the database
 * insists on, not a field an importer can skip.
 */
export const useCases = pgTable(
  'use_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    category: useCaseCategory('category').notNull(),

    /** Preferred: resolves to a real profile and pulls the graph in behind it. */
    authorBuilderId: uuid('author_builder_id').references(() => builders.id, {
      onDelete: 'restrict',
    }),
    /** Falls back to this when the author has no builder entry yet. */
    authorName: text('author_name'),
    /** Why this person is the one telling you. Required. */
    authorCredential: text('author_credential').notNull(),

    cityId: uuid('city_id').references(() => cities.id, { onDelete: 'set null' }),
    date: date('date').notNull(),
    problem: text('problem').notNull(),
    context: text('context').notNull(),
    /** What Claude did. Specific, not "helped". */
    claudeDid: text('claude_did').array().notNull(),
    /** What the person did. Judgement, verification, the corrections. */
    humanDid: text('human_did').array().notNull(),
    tools: text('tools')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    result: text('result').notNull(),
    imageId: uuid('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** A repository asset path. See `cities.imagePath`. */
    imagePath: text('image_path'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    status: contentStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    check('use_cases_credential_present', sql`length(trim(${table.authorCredential})) > 0`),
    /** A byline needs a name from somewhere: a profile, or the plain field. */
    check(
      'use_cases_author_identified',
      sql`${table.authorBuilderId} IS NOT NULL OR ${table.authorName} IS NOT NULL`,
    ),
    /**
     * Both halves of the split are required. A record that cannot say what the
     * person contributed is a product demo, not a workflow.
     */
    check(
      'use_cases_both_sides_present',
      sql`cardinality(${table.claudeDid}) > 0 AND cardinality(${table.humanDid}) > 0`,
    ),
    index('use_cases_author_idx').on(table.authorBuilderId),
    index('use_cases_status_idx').on(table.status),
  ],
);

export const useCaseWorkflowSteps = pgTable(
  'use_case_workflow_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    useCaseId: uuid('use_case_id')
      .notNull()
      .references(() => useCases.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    title: text('title').notNull(),
    detail: text('detail').notNull(),
    /** Who did this step. The split is the whole point of the record. */
    by: workflowActor('by').notNull(),
  },
  (table) => [uniqueIndex('use_case_step_position_unique').on(table.useCaseId, table.position)],
);

/** A prompt or artefact, only where the author approved sharing it. */
export const useCaseArtifacts = pgTable(
  'use_case_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    useCaseId: uuid('use_case_id')
      .notNull()
      .references(() => useCases.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    label: text('label').notNull(),
    body: text('body').notNull(),
  },
  (table) => [uniqueIndex('use_case_artifact_position_unique').on(table.useCaseId, table.position)],
);

// =========================================================================
// GUIDES
// =========================================================================

export const guides = pgTable(
  'guides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    /** The question this answers, in the words someone would actually ask. */
    question: text('question').notNull(),
    standfirst: text('standfirst').notNull(),

    authorBuilderId: uuid('author_builder_id').references(() => builders.id, {
      onDelete: 'restrict',
    }),
    authorName: text('author_name'),
    authorCredential: text('author_credential').notNull(),

    published: date('published').notNull(),
    /** Set whenever the body changes materially. Rendered, and in the JSON-LD. */
    modified: date('modified'),
    readingMinutes: smallint('reading_minutes'),
    imageId: uuid('image_id').references(() => media.id, { onDelete: 'set null' }),
    /** A repository asset path. See `cities.imagePath`. */
    imagePath: text('image_path'),
    status: contentStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    check('guides_credential_present', sql`length(trim(${table.authorCredential})) > 0`),
    check(
      'guides_author_identified',
      sql`${table.authorBuilderId} IS NOT NULL OR ${table.authorName} IS NOT NULL`,
    ),
    check(
      'guides_modified_after_published',
      sql`${table.modified} IS NULL OR ${table.modified} >= ${table.published}`,
    ),
  ],
);

export const guideSections = pgTable(
  'guide_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guideId: uuid('guide_id')
      .notNull()
      .references(() => guides.id, { onDelete: 'cascade' }),
    position: smallint('position').notNull(),
    heading: text('heading'),
    paragraphs: text('paragraphs').array().notNull(),
  },
  (table) => [uniqueIndex('guide_section_position_unique').on(table.guideId, table.position)],
);

// =========================================================================
// SOURCES AND LINKS — cited, so a reader can check
// =========================================================================

export const sourceOwner = pgEnum('source_owner', ['use_case', 'guide']);
export const linkOwner = pgEnum('link_owner', ['builder', 'ambassador', 'city']);

/** An external fact leaned on, cited so a reader can check it themselves. */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerType: sourceOwner('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    position: smallint('position').notNull(),
    label: text('label').notNull(),
    url: text('url'),
    /** When it was checked, for anything that can go stale. */
    retrieved: date('retrieved'),
  },
  (table) => [
    uniqueIndex('source_position_unique').on(table.ownerType, table.ownerId, table.position),
  ],
);

export const socialLinks = pgTable(
  'social_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerType: linkOwner('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    position: smallint('position').notNull(),
    label: text('label').notNull(),
    url: text('url').notNull(),
  },
  (table) => [
    uniqueIndex('link_position_unique').on(table.ownerType, table.ownerId, table.position),
  ],
);

// =========================================================================
// SUBMISSIONS — the public inbox
// =========================================================================

/**
 * One thing somebody sent in through `/api/submit`.
 *
 * THIS TABLE IS AN INBOX, NOT A DRAFT.
 *
 * A row here creates no builder, no project, no use case and no city. It
 * changes nothing that is public. `entity_type` and `entity_id` are written by
 * a reviewer, later, if and when they decide to make something from it — they
 * are the outcome of a decision, never part of what was posted.
 *
 * `payload` keeps the raw submitted object exactly as validated, so a
 * reviewer reads what the person actually wrote rather than what a mapper
 * decided to keep.
 *
 * `submitter_email`, `ip_hash` and `user_agent` are private. They exist for
 * acknowledgement, for abuse handling, and for editorial follow-up. Nothing
 * public may ever select them — there is no public read path to this table at
 * all.
 */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: submissionKind('kind').notNull(),
    /** The raw validated payload, retained verbatim. */
    payload: jsonb('payload').notNull(),

    submitterName: text('submitter_name'),
    /** Private. Never rendered publicly. */
    submitterEmail: text('submitter_email').notNull(),
    /** Set only once contributor accounts exist. Phase 2 and later. */
    submitterUserId: uuid('submitter_user_id').references(() => users.id, { onDelete: 'set null' }),

    status: submissionStatus('status').notNull().default('pending'),

    /** Written by a reviewer if this becomes a record. Never by the submitter. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),

    reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    reviewerNote: text('reviewer_note'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),

    /** Salted hash. The raw address is never stored. */
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** A review outcome is only coherent once somebody reviewed it. */
    check(
      'submissions_reviewed_has_reviewer',
      sql`${table.reviewedAt} IS NULL OR ${table.reviewerId} IS NOT NULL`,
    ),
    /** An entity link needs both halves or neither. */
    check(
      'submissions_entity_pair',
      sql`(${table.entityType} IS NULL) = (${table.entityId} IS NULL)`,
    ),
    index('submissions_status_idx').on(table.status),
    index('submissions_kind_idx').on(table.kind),
    index('submissions_created_idx').on(table.createdAt),
    /** Rate limiting reads these two together. */
    index('submissions_ip_created_idx').on(table.ipHash, table.createdAt),
    index('submissions_email_created_idx').on(table.submitterEmail, table.createdAt),
  ],
);

// =========================================================================
// CITY INTEREST
// =========================================================================

/**
 * Somebody saying "I am here".
 *
 * Rows arrive unverified and unverified rows count for nothing. Only
 * `verified_at` records feed the interest count a city's derived state reads,
 * which is what stops a form from being able to conjure a chapter.
 *
 * `city_id` is nullable on purpose: people register interest in places that
 * are not on the atlas yet, and `city_name` keeps what they actually typed.
 */
export const cityInterest = pgTable(
  'city_interest',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What the person typed. Kept verbatim even after a city is matched. */
    cityName: text('city_name').notNull(),
    cityId: uuid('city_id').references(() => cities.id, { onDelete: 'set null' }),
    /** Private. Never rendered publicly. */
    email: text('email').notNull(),
    doing: text('doing'),
    helping: text('helping'),
    /** The inbox item this came from. Every row has one in Phase 1. */
    submissionId: uuid('submission_id').references(() => submissions.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'city_interest_verified_has_verifier',
      sql`${table.verifiedAt} IS NULL OR ${table.verifiedBy} IS NOT NULL`,
    ),
    /** One signal per person per city. A second submission updates the first. */
    uniqueIndex('city_interest_email_city_unique').on(table.email, table.cityName),
    index('city_interest_city_idx').on(table.cityId),
  ],
);

// =========================================================================
// AUDIT LOG — append-only
// =========================================================================

/**
 * Every editorial action, kept forever.
 *
 * Created now, in Phase 1, even though the interface that writes to it is
 * Phase 2 — because a log that starts the day the dashboard ships cannot
 * answer questions about the day before it shipped.
 *
 * Append-only is enforced by triggers in the migration, not by convention: an
 * UPDATE or DELETE against this table raises. That is the difference between
 * an audit log and a table that happens to be named one.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Kept alongside the id so the entry survives the account being removed. */
    actorEmail: text('actor_email'),
    /** e.g. `submission.approved`, `builder.published`, `ambassador.verified`. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),

    /**
     * The transition, as its own columns rather than buried in `before`/`after`.
     *
     * The audit page's whole job is to show what moved from where to where, and
     * digging that out of two JSON blobs on every row makes the one question
     * anybody asks of this table the most expensive one to answer. `text`
     * rather than the enum because this log outlives any particular
     * vocabulary — an entry written today must still read correctly after a
     * status is renamed or retired.
     */
    fromStatus: text('from_status'),
    toStatus: text('to_status'),

    /** Full state before and after, for anything that changed a whole record. */
    before: jsonb('before'),
    after: jsonb('after'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_entity_idx').on(table.entityType, table.entityId),
    index('audit_log_created_idx').on(table.createdAt),
    index('audit_log_actor_idx').on(table.actorId),
  ],
);

// =========================================================================
// RELATIONS
// =========================================================================

export const citiesRelations = relations(cities, ({ one, many }) => ({
  organiser: one(organizations, { fields: [cities.organiserId], references: [organizations.id] }),
  image: one(media, { fields: [cities.imageId], references: [media.id] }),
  builders: many(builders),
  events: many(events),
  projects: many(projects),
  ambassadors: many(ambassadors),
}));

export const buildersRelations = relations(builders, ({ one, many }) => ({
  city: one(cities, { fields: [builders.cityId], references: [cities.id] }),
  image: one(media, { fields: [builders.imageId], references: [media.id] }),
  projects: many(projectBuilders),
  coHosted: many(eventCoHosts),
  spokeAt: many(eventSpeakers),
}));

export const ambassadorsRelations = relations(ambassadors, ({ one, many }) => ({
  city: one(cities, { fields: [ambassadors.cityId], references: [cities.id] }),
  builder: one(builders, { fields: [ambassadors.builderId], references: [builders.id] }),
  events: many(events),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  city: one(cities, { fields: [events.cityId], references: [cities.id] }),
  ambassador: one(ambassadors, { fields: [events.ambassadorId], references: [ambassadors.id] }),
  coverImage: one(media, { fields: [events.coverImageId], references: [media.id] }),
  coHosts: many(eventCoHosts),
  speakers: many(eventSpeakers),
  organizations: many(eventOrganizations),
  agenda: many(eventAgendaItems),
  outcomes: many(eventOutcomes),
  photos: many(eventPhotos),
  projects: many(projects),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  city: one(cities, { fields: [projects.cityId], references: [cities.id] }),
  builtAtEvent: one(events, { fields: [projects.builtAtEventId], references: [events.id] }),
  image: one(media, { fields: [projects.imageId], references: [media.id] }),
  builders: many(projectBuilders),
}));

export const useCasesRelations = relations(useCases, ({ one, many }) => ({
  authorBuilder: one(builders, {
    fields: [useCases.authorBuilderId],
    references: [builders.id],
  }),
  city: one(cities, { fields: [useCases.cityId], references: [cities.id] }),
  project: one(projects, { fields: [useCases.projectId], references: [projects.id] }),
  event: one(events, { fields: [useCases.eventId], references: [events.id] }),
  workflow: many(useCaseWorkflowSteps),
  artifacts: many(useCaseArtifacts),
}));

export const guidesRelations = relations(guides, ({ one, many }) => ({
  authorBuilder: one(builders, { fields: [guides.authorBuilderId], references: [builders.id] }),
  sections: many(guideSections),
}));

export const submissionsRelations = relations(submissions, ({ one }) => ({
  reviewer: one(users, { fields: [submissions.reviewerId], references: [users.id] }),
  submitter: one(users, { fields: [submissions.submitterUserId], references: [users.id] }),
}));

export const cityInterestRelations = relations(cityInterest, ({ one }) => ({
  city: one(cities, { fields: [cityInterest.cityId], references: [cities.id] }),
  submission: one(submissions, {
    fields: [cityInterest.submissionId],
    references: [submissions.id],
  }),
}));
