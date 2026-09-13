-- ============================================================================
-- 0012 — Host attribution as a relationship, and an ambassador identity that
--        can be matched against a source.
--
-- ADDITIVE ONLY. Four columns on `ambassadors`, two enums, one table, and a
-- backfill that reads a column this migration does not change. Nothing is
-- dropped, nothing is rewritten, and no existing row loses a value. §51.
--
-- ── WHAT WAS MISSING ────────────────────────────────────────────────────────
--
-- `events.ambassador_id` records ONE host and nothing about them: no role, no
-- provenance, no confidence. That is enough to give an event its verified
-- treatment, and not enough for anything §17–§22 asks for. A co-host earns
-- 0.5 of an event credit; an organiser earns 1.0; a partner 0.25 — none of
-- which a single nullable column can represent, and none of which should
-- become three more columns on a table 71 prerendered pages read.
--
-- `ambassadors` had no way to be recognised in a feed either. The Claude
-- Community ICS calendar identifies a host as `ORGANIZER;CN="Some Name"` with
-- a generic calendar MAILTO — a display name and nothing else. So the only
-- honest match key is one a human configures, which is what
-- `luma_display_name` is for. See the schema comments; the short version is
-- that matching is exact on a normalised, admin-entered string, never fuzzy,
-- and the unique index below makes an ambiguous match unrepresentable rather
-- than merely unlikely (§16).
-- ============================================================================

-- ── AMBASSADOR IDENTITY ─────────────────────────────────────────────────────
-- All four nullable, because all four describe facts we may not have. An
-- ambassador verified from a public source has no member account (§25) and no
-- Luma user id (no API access to the calendar), and that is the normal case
-- rather than an incomplete row.
ALTER TABLE "ambassadors" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD COLUMN "luma_profile_url" text;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD COLUMN "luma_external_id" text;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD COLUMN "luma_display_name" text;--> statement-breakpoint

-- ON DELETE SET NULL, not cascade: retiring a member account must not delete
-- the record of who hosted community events. §52.
ALTER TABLE "ambassadors" ADD CONSTRAINT "ambassadors_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- One ambassador per member account, and per Luma user id. Both are identity
-- claims, and an identity that two rows can hold is not one.
CREATE UNIQUE INDEX "ambassadors_member_unique" ON "ambassadors" ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ambassadors_luma_external_unique" ON "ambassadors" ("luma_external_id");--> statement-breakpoint

-- THE ONE THAT MAKES MATCHING SAFE.
--
-- Unique on the NORMALISED display name, so `"Aniket Sahu"`, `"aniket sahu"`
-- and `" Aniket Sahu "` cannot be configured against two different
-- ambassadors. The matcher in `src/server/events/hosts.ts` normalises the
-- feed's organiser string the same way and looks for exactly one row; with
-- this index, "exactly one" is guaranteed by the database and the matcher
-- never has to break a tie by guessing.
CREATE UNIQUE INDEX "ambassadors_luma_display_name_unique" ON "ambassadors" (lower(btrim("luma_display_name"))) WHERE "luma_display_name" IS NOT NULL;--> statement-breakpoint

-- ── HOST ATTRIBUTION ────────────────────────────────────────────────────────
CREATE TYPE "public"."event_host_role" AS ENUM('primary_host', 'co_host', 'organizer', 'partner', 'speaker');--> statement-breakpoint
CREATE TYPE "public"."event_host_source" AS ENUM('curated', 'ingest', 'manual');--> statement-breakpoint

CREATE TABLE "event_hosts" (
  "event_id" uuid NOT NULL,
  "ambassador_id" uuid NOT NULL,
  "role" "event_host_role" NOT NULL,
  "source" "event_host_source" NOT NULL,
  "confidence" numeric(3, 2) DEFAULT '1.00' NOT NULL,
  "source_label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- §19: one credit per event/role combination. Double counting is not
  -- prevented here by careful code; it is unrepresentable.
  CONSTRAINT "event_hosts_event_id_ambassador_id_role_pk" PRIMARY KEY("event_id","ambassador_id","role"),
  CONSTRAINT "event_hosts_confidence_range" CHECK ("event_hosts"."confidence" BETWEEN 0 AND 1)
);--> statement-breakpoint

ALTER TABLE "event_hosts" ADD CONSTRAINT "event_hosts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_hosts" ADD CONSTRAINT "event_hosts_ambassador_id_ambassadors_id_fk" FOREIGN KEY ("ambassador_id") REFERENCES "public"."ambassadors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ONE PRIMARY HOST PER EVENT.
--
-- This is what makes the invariant `events.ambassador_id == the primary_host
-- row, or NULL` statable at all. A second person who ran the room is a
-- `co_host`, which §19 scores at 0.5 — not a second primary host.
CREATE UNIQUE INDEX "event_hosts_one_primary" ON "event_hosts" ("event_id") WHERE role = 'primary_host';--> statement-breakpoint
CREATE INDEX "event_hosts_ambassador_idx" ON "event_hosts" ("ambassador_id");--> statement-breakpoint

-- ── BACKFILL ────────────────────────────────────────────────────────────────
--
-- Every event that already names an ambassador gets the `primary_host` row
-- that names them, marked `curated` because a human authored the column this
-- reads. Confidence 1.00: these are the attributions the archive was built on.
--
-- This is the step that makes the new table the same record as the old column
-- rather than a second, emptier one — after it, the invariant holds for every
-- existing row, and `ON CONFLICT DO NOTHING` makes re-running it a no-op.
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00
FROM "events"
WHERE "ambassador_id" IS NOT NULL
ON CONFLICT DO NOTHING;
