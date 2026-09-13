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
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
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

export const publicationStatus = pgEnum('publication_status', ['draft', 'published', 'archived', 'deleted']);
export const moderationState = pgEnum('moderation_state', ['clean', 'reported', 'restricted', 'archived', 'removed']);
export const projectMemberRole = pgEnum('project_member_role', ['collaborator', 'contributor']);
export const mediaStatus = pgEnum('media_status', ['staged', 'published', 'deleted']);

export const reportReason = pgEnum('report_reason', [
  'spam', 'impersonation', 'harassment', 'misleading', 'stolen_work',
  'unsafe_link', 'inappropriate_content', 'copyright', 'duplicate', 'privacy', 'other'
]);
export const reportStatus = pgEnum('report_status', ['open', 'triaged', 'investigating', 'resolved', 'dismissed']);
export const reportSeverity = pgEnum('report_severity', ['low', 'medium', 'high', 'critical']);

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

// ── Phase A — public members ────────────────────────────────────────────
//
// Declared up here with the other enums rather than beside their tables,
// because `builders` uses `content_source` and a pgEnum is an eagerly
// evaluated const. The tables themselves live further down, under PHASE A.

/**
 * A member is suspended or deleted as a STATE, never by removing the row.
 * `deleted` disconnects the identity and hides the profile; it does not orphan
 * whatever they published.
 */
export const memberStatus = pgEnum('member_status', ['active', 'suspended', 'deleted']);

/**
 * `unlisted` is not private. It means not promoted and not indexed — the page
 * still answers to anybody holding the URL. A genuinely private profile would
 * require every public reader to become status-aware, and Phase A does not
 * need an access-control system.
 */
export const profileVisibility = pgEnum('profile_visibility', ['public', 'unlisted']);

/**
 * How a claim was proven.
 *
 * READ THE ABSENCE. There is no `name_match`, no `city_match`, no
 * `similarity`. Resemblance is not proof of identity, and the way to stop it
 * being used as proof by some future well-meaning change is for the value not
 * to exist.
 */
export const claimProofType = pgEnum('claim_proof_type', [
  'github_identity',
  'linkedin_identity',
  'email_identity',
  'moderator_review',
]);

export const claimStatus = pgEnum('claim_status', ['pending', 'approved', 'rejected', 'cancelled']);

/** Where a record came from. Decides which publish path may touch it. */
export const contentSource = pgEnum('content_source', ['legacy', 'user']);

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
  ownerMemberId: uuid('owner_member_id').references(() => members.id, { onDelete: 'set null' }),
  /**
   * The project this image was uploaded for, when it was uploaded for one.
   *
   * Nullable because most rows in this table have no project and never will:
   * every curated event photo and city picture predates member uploads, and an
   * avatar belongs to a member rather than a project.
   *
   * Cascades on delete — unlike every other foreign key here, which sets null.
   * A media row whose only purpose was one project has no meaning once that
   * project is gone, whereas an event photo outlives the event's editor.
   */
  projectId: uuid('project_id').references((): any => projects.id, { onDelete: 'cascade' }),
  blobUrl: text('blob_url'),
  pathname: text('pathname'),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  /** Path relative to `src/assets`, e.g. `events/vol02-1.jpg`. */
  path: text('path').unique(),
  alt: text('alt').notNull(),
  caption: text('caption'),
  credit: text('credit'),
  consent: boolean('consent').notNull().default(false),
  status: mediaStatus('status').notNull().default('published'),
  kind: mediaKind('kind').notNull().default('other'),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  deletionReason: text('deletion_reason'),
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

    /**
     * The member who has PROVEN they are this person. Phase A.
     *
     * Nullable, and staying that way: all 72 imported builders keep NULL,
     * which is exactly what "unclaimed" means. It is set by a resolved
     * `profile_claims` row and by nothing else — never inferred from a
     * matching name, which is why `claim_proof_type` has no `name_match`.
     */
    ownerMemberId: uuid('owner_member_id').references(() => members.id, { onDelete: 'set null' }),

    /**
     * `legacy` for everything the importer created, `user` for everything a
     * member creates. This is what lets a member self-publish their own row
     * while the curated archive keeps going through the editorial state
     * machine — two publish paths that cannot reach each other's records.
     */
    source: contentSource('source').notNull().default('legacy'),

    moderationState: moderationState('moderation_state').notNull().default('clean'),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletionReason: text('deletion_reason'),
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
    index('builders_owner_idx').on(table.ownerMemberId),
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

    /**
     * The WITH CLAUDE account, when this person has claimed one.
     *
     * NULL is the normal state and not a gap. An ambassador record exists
     * because their status was verified from a public source; whether they
     * have since logged in is a separate fact. §25: an ambassador may exist
     * without a member account, and a member is never forced into ambassador
     * status.
     *
     * This is a LINK and not a second identity. Everything a member edits
     * about themselves stays in `member_profiles`, projected into `builders`;
     * nothing about a profile is copied here. That is what keeps §24's "no
     * duplicated profile content" true by construction — the ambassador page
     * reads the builder record through this join rather than holding its own
     * copy of a bio.
     */
    memberId: uuid('member_id').references(() => members.id, { onDelete: 'set null' }),

    /**
     * ── LUMA IDENTITY ────────────────────────────────────────────────────
     *
     * Three columns because the feed we actually have gives us exactly one of
     * the three, and pretending otherwise is how attribution goes wrong.
     *
     * `lumaProfileUrl`  the public profile page. Editorial: it is a link on
     *                   the ambassador page. NOT used for matching, because a
     *                   calendar feed never mentions it.
     *
     * `lumaExternalId`  Luma's own stable user id, if we are ever granted API
     *                   access to a calendar that exposes it. This is the
     *                   PREFERRED match key (§16.1) and is unique. Null today.
     *
     * `lumaDisplayName` the exact organiser name as the source prints it.
     *
     * That last one is the only key the Claude Community ICS feed makes
     * available: every VEVENT carries `ORGANIZER;CN="Some Name"` and a generic
     * calendar MAILTO, so the display name is the whole of the identity on
     * offer. It is therefore a MANUALLY CONFIGURED MAPPING — an admin types
     * the organiser string they have actually seen against the ambassador it
     * belongs to — and matching is exact on the normalised value, never fuzzy.
     * §16 forbids matching ambassadors by name similarity; it permits an
     * explicitly configured, human-verified mapping, which is this.
     *
     * The unique index on the normalised value is what makes an ambiguous
     * match impossible rather than merely unlikely: two ambassadors cannot
     * both claim one organiser string, so the matcher never has to choose.
     */
    lumaProfileUrl: text('luma_profile_url'),
    lumaExternalId: text('luma_external_id'),
    lumaDisplayName: text('luma_display_name'),
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
    /** One ambassador record per member account, for the same reason. */
    uniqueIndex('ambassadors_member_unique').on(table.memberId),
    /** The preferred match key, when a source ever gives us one. */
    uniqueIndex('ambassadors_luma_external_unique').on(table.lumaExternalId),
    /**
     * The key the ICS feed actually makes matchable, normalised.
     *
     * With this index an organiser string cannot be configured against two
     * ambassadors, so `matchAmbassador()` looking for "exactly one row" is a
     * database guarantee rather than a hope. §16.
     */
    uniqueIndex('ambassadors_luma_display_name_unique')
      .on(sql`lower(btrim(${table.lumaDisplayName}))`)
      .where(sql`${table.lumaDisplayName} IS NOT NULL`),
  ],
);

// =========================================================================
// EVENT INGESTION
// =========================================================================

/**
 * How a source is polled.
 *
 * `webhook` and `api` are only reachable for a calendar we administer and hold
 * credentials for. The Claude Community calendar is neither: it exposes a
 * public ICS feed and nothing else, so `ics` is what it actually runs on. The
 * enum carries all four because the mode is a property of a source rather than
 * of the code, and a source whose access changes should not need a migration.
 */
export const eventSyncMode = pgEnum('event_sync_mode', ['api', 'webhook', 'ics', 'manual']);

/** The outcome of the last run, so health can be answered without re-running it. */
export const eventSyncStatus = pgEnum('event_sync_status', ['never', 'ok', 'partial', 'failed']);

/**
 * What happened to one external event on the way in.
 *
 * `review` is the important one. §21 forbids both publishing an event we
 * cannot confidently place in India and silently discarding it, which leaves
 * exactly one option: keep it, say why, and show nobody until a human decides.
 */
export const eventRecordState = pgEnum('event_record_state', [
  'pending',
  'promoted',
  'review',
  'rejected',
  'withdrawn',
]);

/**
 * A configured external calendar.
 *
 * NOTHING HERE IS A CREDENTIAL. `feedUrl` is a public URL and `calendarId` is
 * a public identifier; an API key, if one ever exists for a source, stays in
 * the environment and is read per-request. A row in this table is safe to
 * print in a health response, which is the whole reason the sync state lives
 * here rather than in a log.
 */
export const eventSources = pgTable('event_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stable handle used by code and cron, e.g. `luma:claudecommunity`. */
  key: text('key').notNull().unique(),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  syncMode: eventSyncMode('sync_mode').notNull(),
  /**
   * The provider's own calendar identifier.
   *
   * For Luma this is the `cal-…` api_id and NOT the public slug — the ICS
   * endpoint answers 404 to the slug, which is the kind of fact that costs an
   * afternoon if it is not written down.
   */
  calendarId: text('calendar_id'),
  feedUrl: text('feed_url'),
  enabled: boolean('enabled').notNull().default(true),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastSyncStatus: eventSyncStatus('last_sync_status').notNull().default('never'),
  /** A short, safe summary. Never a stack trace, never a URL with a secret. */
  lastSyncMessage: text('last_sync_message'),
  lastSeenCount: integer('last_seen_count'),
  lastPromotedCount: integer('last_promoted_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every external event ever seen, normalised — and NOT the public record.
 *
 * The staging table exists because `events` is the curated public record that
 * the entire `RecordSet` reads, and its NOT NULLs (`cityId`, `venueName`,
 * `summary`, `format`) are the reason the prerendered pages need no null
 * checks. A feed cannot honour them. Rather than weaken the table that 71
 * pages depend on, ingestion lands here and only confidently-placed events
 * are promoted across.
 *
 * That also gives §21 somewhere to put the events it refuses to guess about,
 * and §23 somewhere to notice that an event has stopped appearing.
 */
export const eventSourceRecords = pgTable(
  'event_source_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => eventSources.id, { onDelete: 'cascade' }),
    /** For Luma ICS, the `UID` with `@events.lu.ma` stripped: `evt-…`. */
    externalId: text('external_id').notNull(),

    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    timezone: text('timezone'),
    locationRaw: text('location_raw'),
    country: text('country'),
    cityName: text('city_name'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    organizer: text('organizer'),
    registrationUrl: text('registration_url'),
    coverUrl: text('cover_url'),
    /** The source's own revision counter, where it has one (ICS `SEQUENCE`). */
    sequence: bigint('sequence', { mode: 'number' }),
    /**
     * The source's own cancellation signal, where it has one.
     *
     * The Claude Community ICS feed reports `TENTATIVE` on all 317 of its
     * events, so for that feed this is not a usable signal and disappearance
     * from the feed is the only real one. Recorded anyway, because a feed that
     * starts telling the truth should be believed without a migration.
     */
    sourceStatus: text('source_status'),

    state: eventRecordState('state').notNull().default('pending'),
    /** A fixed code explaining `review`/`rejected`. Never free text from the feed. */
    stateReason: text('state_reason'),
    /** How confidently this was placed in India, 0–100. See `classifyIndia()`. */
    indiaConfidence: smallint('india_confidence'),
    eventId: uuid('event_id').references(() => events.id, { onDelete: 'set null' }),
    cityId: uuid('city_id').references(() => cities.id, { onDelete: 'set null' }),

    /**
     * SHA-256 of the normalised payload.
     *
     * An equal hash means nothing changed and the upsert skips the write. That
     * is what keeps a daily sync of 317 events from being 317 pointless
     * UPDATEs, and it is also what makes `lastChangedAt` mean something.
     */
    rawHash: text('raw_hash').notNull(),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * THE IDEMPOTENCY KEY.
     *
     * §43 asks that every external ingestion be idempotent. This is where that
     * is actually true: the constraint is in the database, so a sync that runs
     * twice, or twice concurrently, cannot produce two rows for one Luma event
     * no matter what the calling code forgets to check.
     */
    uniqueIndex('event_source_records_identity_unique').on(table.sourceId, table.externalId),
    index('event_source_records_state_idx').on(table.state),
    index('event_source_records_starts_idx').on(table.startsAt),
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
     * ── WHERE THIS EVENT CAME FROM ──────────────────────────────────────
     *
     * Null on every hand-authored event, and that is load-bearing rather than
     * incidental: `promote()` in `src/server/events/sync.ts` will only ever
     * UPDATE a row whose `sourceId` matches the source it is syncing, so a
     * curated event cannot be overwritten, restyled or cancelled by an
     * external feed. The curated archive and the ingested calendar share a
     * table and never share a row.
     */
    sourceId: uuid('source_id').references(() => eventSources.id, { onDelete: 'set null' }),
    /** The provider's own id, e.g. a Luma `evt-…`. Unique per source. */
    externalId: text('external_id'),
    /** IANA zone from the source, when it names one. `date`/`startTime` stay local. */
    timezone: text('timezone'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    /**
     * The event is off.
     *
     * Set when the source says so, or when an event that used to be in the
     * feed stops being in it. `/events/[slug]` checks this before printing a
     * registration CTA, because §23 is precisely that a cancelled event must
     * stop advertising a door that is not going to open.
     */
    canceledAt: timestamp('canceled_at', { withTimezone: true }),

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
    uniqueIndex('events_source_external_unique')
      .on(table.sourceId, table.externalId)
      .where(sql`${table.sourceId} IS NOT NULL AND ${table.externalId} IS NOT NULL`),
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

/**
 * WHO RAN AN EVENT — the canonical attribution relationship.
 *
 * §17 asks for `event_hosts` rather than more ambassador columns on `events`,
 * and §19 asks for a transparent leaderboard. Both need the same thing: a row
 * per (event, person, role) that says how confident we are and where the claim
 * came from. A column cannot carry a role, a provenance and a confidence, and
 * three columns for three roles cannot carry a fourth.
 *
 * ── RELATIONSHIP TO `events.ambassador_id` ───────────────────────────────
 *
 * `events.ambassador_id` STAYS, and is the denormalised primary host. It is
 * not a competing record: the invariant, enforced by `setEventHosts()` in
 * `src/server/events/hosts.ts` and asserted by the test suite, is
 *
 *     events.ambassador_id  ==  the ambassador_id of this event's
 *                               single `primary_host` row, or NULL
 *
 * The column is kept because it is load-bearing in a way that is easy to
 * underestimate: `RecordSet` flows from it, `cityState()` decides that a city
 * is ambassador-led from it, and 71 prerendered pages read it with no null
 * checks. Replacing it with a join would mean rewriting the data source, the
 * equivalence suite and the city model to gain nothing a reader can see.
 *
 * So: ONE writer, ONE invariant, and the join table owns everything the column
 * cannot express. §19's credit for a co-host, an organiser or a partner exists
 * only here.
 *
 * ── WHY IT POINTS AT AMBASSADORS AND NOT BUILDERS ────────────────────────
 *
 * Because `event_co_hosts`, `event_speakers` and `event_attendees` already
 * point at builders, and they stay exactly as they are — they are the curated
 * archive's record of who was in a room, and nothing here replaces them. This
 * table answers a narrower question: who gets community-activity CREDIT for
 * running the event, which §19 scores and §22 ranks. That credit belongs to a
 * verified ambassador record or to nobody, which is also why an unmatched
 * organiser produces no row at all rather than a row with a low confidence.
 */
export const eventHostRole = pgEnum('event_host_role', [
  'primary_host',
  'co_host',
  'organizer',
  'partner',
  'speaker',
]);

/**
 * How this attribution was established. Never inferred, always recorded.
 *
 * `curated`  a human authored it in the record, or it was backfilled from
 *            `events.ambassador_id`, which a human authored.
 * `ingest`   a sync matched the source's organiser against a configured Luma
 *            identity. Exact match on a mapping an admin set up — see
 *            `ambassadors.lumaDisplayName`.
 * `manual`   a moderator corrected or added it in the admin. §37.
 */
export const eventHostSource = pgEnum('event_host_source', ['curated', 'ingest', 'manual']);

export const eventHosts = pgTable(
  'event_hosts',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    ambassadorId: uuid('ambassador_id')
      .notNull()
      .references(() => ambassadors.id, { onDelete: 'cascade' }),
    role: eventHostRole('role').notNull(),
    source: eventHostSource('source').notNull(),
    /**
     * How sure we are, 0–1. Scored credit requires 1.
     *
     * §19: "if event attribution is ambiguous, do not automatically score it".
     * A row below 1 is a real, recorded, VISIBLE attribution that deliberately
     * earns nothing until a moderator confirms it — which is what lets the
     * system hold an uncertain claim without either discarding it or letting
     * it move a ranking. `scoreOf()` in `src/lib/leaderboard.ts` is the only
     * reader of this column.
     */
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('1.00'),
    /** What the source actually said, when a name was matched. For review. */
    sourceLabel: text('source_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * §19: "only one credit should come from each actual event/role
     * combination". The primary key IS that rule — double counting one
     * ambassador twice in one role on one event is not prevented by careful
     * code, it is unrepresentable.
     */
    primaryKey({ columns: [table.eventId, table.ambassadorId, table.role] }),
    /**
     * AND ONE PRIMARY HOST PER EVENT.
     *
     * Without this, two ambassadors could each hold a `primary_host` row and
     * `events.ambassador_id` could only mirror one of them — the invariant at
     * the top of this comment would be unstateable. A second person who ran
     * the room is a `co_host`, which is exactly what §19 scores at 0.5.
     */
    uniqueIndex('event_hosts_one_primary')
      .on(table.eventId)
      .where(sql`role = 'primary_host'`),
    check('event_hosts_confidence_range', sql`${table.confidence} BETWEEN 0 AND 1`),
    index('event_hosts_ambassador_idx').on(table.ambassadorId),
  ],
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
    ownerMemberId: uuid('owner_member_id').references(() => members.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),

    /**
     * NULLABLE, AND ONLY FOR DRAFTS.
     *
     * Every curated project has a city and every PUBLISHED project must have
     * one — `Project.citySlug` in `src/data/types.ts` is a required string and
     * the prerendered pages dereference it without a null check. That
     * invariant is kept by `assertPublishable()` in
     * `src/server/members/projects.ts`, at the publish boundary.
     *
     * It is not kept by this column, because it cannot be: a member starting a
     * draft has not chosen a city yet, and the previous NOT NULL meant
     * `POST /api/projects` inserted NULL and failed at the database on every
     * single member project creation. Requiring completeness to SAVE is the
     * bug; requiring it to PUBLISH is the rule.
     */
    cityId: uuid('city_id').references(() => cities.id, { onDelete: 'restrict' }),
    /** Nullable for the same reason as `cityId`, required by the same gate. */
    summary: text('summary'),
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
    publicationStatus: publicationStatus('publication_status').notNull().default('draft'),
    moderationState: moderationState('moderation_state').notNull().default('clean'),
    status: contentStatus('status').notNull().default('draft'),
    featured: boolean('featured').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletionReason: text('deletion_reason'),
  },
  (table) => [
    index('projects_publication_idx').on(table.publicationStatus),
    index('projects_moderation_idx').on(table.moderationState),
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

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    role: projectMemberRole('role').notNull().default('collaborator'),
    position: smallint('position').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.memberId] })],
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
// PHASE A — PUBLIC MEMBERS (Privy identity)
// =========================================================================

/**
 * A public member of WITH CLAUDE.
 *
 * DELIBERATELY NOT `users`. That table is the editorial allowlist, which has
 * no sign-up on purpose; this one is open to anybody with a Privy account. One
 * table for both would mean the table deciding who may archive a record is
 * also the table the internet can insert into.
 *
 * NOTHING HERE IS A CREDENTIAL. `privyUserId` is the Privy DID and the only
 * value shared with the authentication provider. There is no access token, no
 * refresh token and no session column, so there is nothing in this table to
 * leak — the server verifies a token in memory per request and keeps only the
 * subject.
 */
export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Privy DID, e.g. `did:privy:…`. The join to the identity provider. */
    privyUserId: text('privy_user_id').notNull().unique(),
    status: memberStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Advanced coarsely on authenticated requests. Not an activity log. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    deletionReason: text('deletion_reason'),
  },
  (table) => [index('members_privy_user_idx').on(table.privyUserId)],
);

/**
 * What a member edits. NOT what the public reads.
 *
 * The published profile lives in `builders`, and one whitelist function
 * projects this row into it. That indirection is what makes the user-owned /
 * source-owned split a mechanism rather than a promise: a projection can only
 * write the columns it names, so editing a bio cannot reach `name`, `roles`,
 * an ambassador link or a historical event credit — on a profile the member
 * created OR one they claimed.
 *
 * It also means the prerendered pages and the search index keep reading
 * exactly the table they already read, which is why Phase A changes nothing
 * about `RecordSet`.
 */
export const memberProfiles = pgTable(
  'member_profiles',
  {
    memberId: uuid('member_id')
      .primaryKey()
      .references(() => members.id, { onDelete: 'cascade' }),

    /** The handle, and the public URL: `/builders/<username>`. Lower-case. */
    username: text('username').notNull().unique(),

    displayName: text('display_name'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    headline: text('headline'),
    bio: text('bio'),

    /**
     * The atlas city, when they are in one. Nullable, with `country` beside
     * it, because `cities` is a curated fourteen and somebody in a fifteenth
     * city must still get a profile. NOTHING HERE CREATES A CITY: city state
     * is derived from verified ambassador and event records, so an
     * auto-created city would be an auto-created chapter.
     */
    cityId: uuid('city_id').references(() => cities.id, { onDelete: 'set null' }),
    country: text('country'),

    website: text('website'),

    /** Phase B. The shape is settled; there is no upload path yet. */
    avatarMediaId: uuid('avatar_media_id').references(() => media.id, { onDelete: 'set null' }),

    /** What they do. Not a trust signal — see `builders.roles`' CHECK. */
    primaryRole: text('primary_role'),

    claudeSince: text('claude_since'),

    /** Opt-in, off by default. Signing in with an email does not publish it. */
    publicEmail: boolean('public_email').notNull().default(false),

    visibility: profileVisibility('visibility').notNull().default('public'),

    /** Null until published. A shell exists from first login; that is not publication. */
    publishedAt: timestamp('published_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Lower-case, 3–30, no leading separator. Enforced here, not only in a form. */
    check('member_profiles_username_shape', sql`${table.username} ~ '^[a-z0-9][a-z0-9_-]{2,29}$'`),
    index('member_profiles_username_idx').on(table.username),
    index('member_profiles_city_idx').on(table.cityId),
  ],
);

/**
 * The handles nobody may take.
 *
 * A table rather than a constant, because it has to be enforced by the same
 * thing that enforces uniqueness — inside the transaction that inserts the
 * username. A route-level check is bypassed by the next route somebody writes.
 */
export const reservedUsernames = pgTable('reserved_usernames', {
  username: text('username').primaryKey(),
  reason: text('reason').notNull(),
});

/**
 * A linked account Privy vouches for, recorded after it has been used.
 *
 * The authoritative read for a claim is a freshly verified identity token —
 * this table is the record of WHAT MATCHED, so a resolved claim can still be
 * explained months later when the member has since unlinked the account.
 *
 * `(provider, providerSubject)` is unique across all members: one GitHub
 * account cannot be the proof behind two different people.
 */
export const memberIdentities = pgTable(
  'member_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** The provider's own stable id for the account. */
    providerSubject: text('provider_subject').notNull(),
    username: text('username'),
    displayName: text('display_name'),
    profileUrl: text('profile_url'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('member_identities_provider_subject_unique').on(
      table.provider,
      table.providerSubject,
    ),
    index('member_identities_member_idx').on(table.memberId),
  ],
);

/**
 * Somebody asserting that an existing builder record is them.
 *
 * `proofValueHash` is a HASH AND NEVER THE VALUE. The email proof compares an
 * authenticated address against a private legacy contact address; storing
 * either would turn this into a store of other people's email addresses, for
 * no product benefit — nothing reads the value back, only the fact that two
 * things matched.
 *
 * `resolvedBy` references the ADMIN `users` table. A moderator acting is the
 * one thing that legitimately crosses between the two identity systems, and
 * it records an action rather than linking two identities.
 */
export const profileClaims = pgTable(
  'profile_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    builderId: uuid('builder_id')
      .notNull()
      .references(() => builders.id, { onDelete: 'cascade' }),
    proofType: claimProofType('proof_type').notNull(),
    /** A hash. Never the proven value. */
    proofValueHash: text('proof_value_hash'),
    status: claimStatus('status').notNull().default('pending'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** The moderator, when a human resolved it. Null for a deterministic match. */
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    index('profile_claims_member_idx').on(table.memberId),
    index('profile_claims_builder_idx').on(table.builderId),
    index('profile_claims_status_idx').on(table.status),

    /**
     * ONE APPROVED CLAIM PER BUILDER, EVER.
     *
     * This is what makes "nobody attaches themselves to another person" a
     * property of the database rather than a rule a route remembers. Two
     * members racing for the same builder both pass any application check; the
     * second to COMMIT hits this index and loses.
     */
    uniqueIndex('profile_claims_one_owner')
      .on(table.builderId)
      .where(sql`${table.status} = 'approved'`),

    /** One OPEN claim per member per builder — no resubmitting in a loop. */
    uniqueIndex('profile_claims_one_open_per_member')
      .on(table.memberId, table.builderId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

// =========================================================================
// REPORTS
// =========================================================================

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterMemberId: uuid('reporter_member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'restrict' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    reason: reportReason('reason').notNull(),
    details: text('details'),
    severity: reportSeverity('severity').notNull().default('low'),
    status: reportStatus('status').notNull().default('open'),
    assignedModeratorId: uuid('assigned_moderator_id').references(() => users.id, { onDelete: 'set null' }),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('reports_status_severity_created_idx').on(table.status, table.severity, table.createdAt),
    index('reports_entity_idx').on(table.entityType, table.entityId),
    index('reports_reporter_idx').on(table.reporterMemberId),
    index('reports_moderator_idx').on(table.assignedModeratorId),
    // Prevent duplicate open reports from the same member against the same entity
    uniqueIndex('reports_unique_open')
      .on(table.reporterMemberId, table.entityType, table.entityId)
      .where(sql`${table.status} = 'open'`),
  ]
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
    /**
     * The MEMBER who acted, when a member did. Phase A.
     *
     * A member publishing their own profile needs somewhere to be logged that
     * does not pretend a moderator did it. Exactly one of `actorId` and this
     * is set on any given entry. The append-only trigger from 0001 still
     * applies, so this adds an actor and not a way to rewrite history.
     *
     * ── `ON DELETE SET NULL` CAN NEVER ACTUALLY FIRE ──────────────────────
     *
     * And that is the correct outcome, so it is written down rather than
     * fixed. Nulling this column is an UPDATE, and 0001's trigger refuses
     * every UPDATE on this table — so a member who has ever acted CANNOT be
     * hard-deleted; the DELETE fails on the cascade.
     *
     * Which is exactly what §12 asks for. A member is retired by setting
     * `members.status = 'deleted'`, never by removing the row, and this makes
     * the database enforce that rather than trusting everyone to remember it.
     * `actorId` above carries the same clause and the same consequence for
     * admin accounts.
     */
    actorMemberId: uuid('actor_member_id').references(() => members.id, { onDelete: 'set null' }),
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
  owner: one(members, { fields: [projects.ownerMemberId], references: [members.id] }),
  city: one(cities, { fields: [projects.cityId], references: [cities.id] }),
  builtAtEvent: one(events, { fields: [projects.builtAtEventId], references: [events.id] }),
  image: one(media, { fields: [projects.imageId], references: [media.id] }),
  builders: many(projectBuilders),
  members: many(projectMembers),
}));

export const projectMembersRelations = relations(projectMembers, ({ one }) => ({
  project: one(projects, { fields: [projectMembers.projectId], references: [projects.id] }),
  member: one(members, { fields: [projectMembers.memberId], references: [members.id] }),
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
