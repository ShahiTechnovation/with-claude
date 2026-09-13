-- ============================================================================
-- 0010 — Event ingestion, and drafts that can actually be saved.
--
-- ADDITIVE ONLY. Nothing is dropped, nothing is rewritten, no existing row
-- changes value. Two independent changes ride together because they are one
-- deployment.
--
-- PART 1 — A DRAFT IS ALLOWED TO BE INCOMPLETE.
--
-- projects.city_id and projects.summary were NOT NULL, which is correct for
-- the curated archive that populated them and wrong for the member creation
-- path: POST /api/projects inserted NULL into both, so every member project
-- creation failed at the database. Publishing, not drafting, is where a
-- project has to be complete — assertPublishable() in
-- src/server/members/projects.ts now enforces that, which is also where the
-- public record's citySlug: string invariant is actually kept.
--
-- Dropping NOT NULL cannot invalidate an existing row.
--
-- PART 2 — WHERE AN EXTERNAL CALENDAR LANDS.
--
-- Ingested events do NOT go straight into events. That table is the curated
-- public record which the whole RecordSet and all the prerendered pages read,
-- and its NOT NULLs (city_id, venue_name, summary, format) are the reason
-- those pages render without a single null check. An external feed cannot
-- honour them: a Luma event in a city outside the curated atlas has nowhere
-- to point city_id, and section 21 says an event we cannot confidently place
-- is to be KEPT FOR REVIEW rather than published or dropped.
--
-- So ingestion has its own table. event_source_records holds every external
-- event ever seen, normalised, with its classification and its resolution
-- state. Rows are promoted into events only once they are confidently in
-- India AND resolve to an atlas city. Everything else sits in the staging
-- table with a reason, visible and reviewable, changing nothing public.
--
-- The idempotency key is (source_id, external_id), so re-running a sync
-- updates rather than duplicates — which is the entire requirement in
-- section 43.
-- ============================================================================

-- PART 1 ---------------------------------------------------------------------
ALTER TABLE "projects" ALTER COLUMN "city_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "summary" DROP NOT NULL;--> statement-breakpoint

-- PART 2 ---------------------------------------------------------------------

-- How a source is polled. webhook is reachable only for a calendar we
-- administer and hold credentials for; ics is the public-feed fallback and is
-- what the Claude Community calendar actually supports today.
CREATE TYPE "public"."event_sync_mode" AS ENUM('api', 'webhook', 'ics', 'manual');--> statement-breakpoint

-- The outcome of the last run. Stored so /api/health can answer "is ingestion
-- working" without re-running it.
CREATE TYPE "public"."event_sync_status" AS ENUM('never', 'ok', 'partial', 'failed');--> statement-breakpoint

-- What happened to one external event on the way in.
--   pending    — seen, not yet classified
--   promoted   — in India, city resolved, present in events
--   review     — cannot be confidently placed. NOT published. Section 21.
--   rejected   — confidently NOT in India. Kept so a re-sync need not re-decide.
--   withdrawn  — vanished from the feed, or cancelled at the source.
CREATE TYPE "public"."event_record_state" AS ENUM('pending', 'promoted', 'review', 'rejected', 'withdrawn');--> statement-breakpoint

CREATE TABLE "event_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Stable handle used by code and cron, e.g. luma:claudecommunity.
  "key" text NOT NULL,
  "provider" text NOT NULL,
  "label" text NOT NULL,
  "sync_mode" "event_sync_mode" NOT NULL,
  -- The provider's own calendar identifier. For Luma, the cal-… api_id — the
  -- public slug is NOT accepted by the ICS endpoint.
  "calendar_id" text,
  -- Resolved feed URL. Never a credential; an API key, if one ever exists,
  -- stays in the environment and is never written here.
  "feed_url" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "last_synced_at" timestamp with time zone,
  "last_sync_status" "event_sync_status" DEFAULT 'never' NOT NULL,
  -- A short, safe summary. Never a stack trace, never a URL with a secret.
  "last_sync_message" text,
  "last_seen_count" integer,
  "last_promoted_count" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "event_sources_key_unique" UNIQUE("key")
);--> statement-breakpoint

CREATE TABLE "event_source_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" uuid NOT NULL,
  -- The provider's stable id for the event. For Luma ICS, the UID with the
  -- @events.lu.ma suffix stripped, e.g. evt-RPZwseE12orCSQ0.
  "external_id" text NOT NULL,

  -- Normalised payload. Deliberately permissive: this is what the feed said,
  -- not what the site promises.
  "title" text NOT NULL,
  "description" text,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone,
  "timezone" text,
  "location_raw" text,
  "country" text,
  "city_name" text,
  "latitude" double precision,
  "longitude" double precision,
  "organizer" text,
  "registration_url" text,
  "cover_url" text,
  -- The source's own revision counter, where it has one (ICS SEQUENCE).
  "sequence" bigint,
  -- The source's own cancellation signal, where it has one. The Claude
  -- Community ICS feed reports TENTATIVE on every event, so for that feed this
  -- stays null and disappearance from the feed is the only real signal.
  "source_status" text,

  "state" "event_record_state" DEFAULT 'pending' NOT NULL,
  -- Why this row is in review or rejected. Shown to a moderator, never a
  -- user. A fixed code, not free text from the feed.
  "state_reason" text,
  -- How confidently this was placed in India, 0-100. See classifyIndia().
  "india_confidence" smallint,
  -- The promoted events row, when there is one.
  "event_id" uuid,
  "city_id" uuid,

  -- SHA-256 of the normalised payload. Equal hash means nothing changed and
  -- the upsert can skip the write entirely, which is what keeps a daily sync
  -- of 317 events from being 317 pointless updates.
  "raw_hash" text NOT NULL,

  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "event_source_records" ADD CONSTRAINT "event_source_records_source_id_event_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."event_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_source_records" ADD CONSTRAINT "event_source_records_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_source_records" ADD CONSTRAINT "event_source_records_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- THE IDEMPOTENCY KEY. One row per external event per source, enforced by the
-- database rather than by the sync remembering to check.
CREATE UNIQUE INDEX "event_source_records_identity_unique" ON "event_source_records" ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "event_source_records_state_idx" ON "event_source_records" ("state");--> statement-breakpoint
CREATE INDEX "event_source_records_starts_idx" ON "event_source_records" ("starts_at");--> statement-breakpoint

-- The link back from a public event to where it came from.
-- Null on every curated event, and it stays null: a hand-authored event has no
-- external source and must never be touched by a sync.
ALTER TABLE "events" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
-- Set when the source says the event is off, or when it disappears from the
-- feed. /events/[slug] refuses to show a registration CTA once it is set.
ALTER TABLE "events" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_id_event_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."event_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- A source cannot own the same external event twice. Partial, so the curated
-- events (both columns null) are unaffected.
CREATE UNIQUE INDEX "events_source_external_unique" ON "events" ("source_id","external_id") WHERE "source_id" IS NOT NULL AND "external_id" IS NOT NULL;
