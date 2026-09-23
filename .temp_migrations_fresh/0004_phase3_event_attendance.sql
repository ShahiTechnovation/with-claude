-- Phase 3 — the attendance credit the record already carries.
--
-- ── WHAT WAS MISSING ─────────────────────────────────────────────────────
--
-- `builders.eventSlugs` in the TypeScript record means "this person was on the
-- record in this room". Phase 1 normalised the two credits it recognised —
-- `event_co_hosts` (ran the room) and `event_speakers` (talked in it) — and
-- both were right to separate, because hosting and presenting are different
-- contributions.
--
-- But there is a third way to be on the record for a room, and the repository
-- has 69 instances of it: the Bhopal Impact Lab cohort. Every one of those
-- builders declares `eventSlugs: ['claude-code-impact-lab']` and none of them
-- co-hosted or spoke. They were there, they built something, and the record
-- says so. With no table for it, `eventsOf()` reading from the database would
-- return fewer rooms than `eventsOf()` reading from TypeScript, and the two
-- sources would not be equivalent.
--
-- The alternative considered and rejected was to infer attendance from
-- `projects.built_at_event_id` — a builder credited on a project built at an
-- event was presumably at it. That happens to reproduce today's data, and it
-- is still wrong: it makes attendance a derived fact that silently disappears
-- the moment somebody attends without shipping, which is most attendees of
-- most events. Attendance is a thing that happened, so it gets stored.
--
-- ── WHY NOT WIDEN ONE OF THE EXISTING TABLES ─────────────────────────────
--
-- Because a `role` column on a single credits table is how "co-hosted" and
-- "turned up" end up one indistinguishable list. The schema's existing choice
-- to keep hosting and speaking apart is the right one, and this follows it: a
-- third credit gets a third table, and a query that wants all three says so.

CREATE TABLE IF NOT EXISTS "event_attendees" (
	"event_id" uuid NOT NULL,
	"builder_id" uuid NOT NULL,
	CONSTRAINT "event_attendees_event_id_builder_id_pk" PRIMARY KEY("event_id","builder_id")
);
--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_events_id_fk"
	FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_builder_id_builders_id_fk"
	FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;
