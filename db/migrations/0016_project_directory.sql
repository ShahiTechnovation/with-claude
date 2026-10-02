CREATE TYPE "public"."project_build_status" AS ENUM('functional', 'partial', 'prototype');--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "rescheduled_from" date;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "short_title" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "provenance" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "problem" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "solution" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "built_with" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "build_status" "project_build_status";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "download_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "artifact_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "alt_video_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "logo_media_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "logo_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_logo_media_id_media_id_fk" FOREIGN KEY ("logo_media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ── IMPACT LAB 2: POSTPONED FROM 13 TO 15 SEPTEMBER 2026 ──────────────────
-- One event, moved. The curated row keeps its UUID and its public slug
-- (`claude-impact-lab-september` carries no date, so it needs no redirect);
-- only the held date changes, and the announced date is kept beside it.
-- 09:00–18:00 IST is the event's own Luma record (evt-mLFu3IoSUvVP1FA,
-- already linked to this row), not anything inferred from submissions.
-- Guarded on the old date and on being the curated row, so a re-run or a
-- database that never had the 13th is untouched. Targeted by slug — never a
-- text replacement across events.
UPDATE "events"
SET "date" = '2026-09-15',
    "rescheduled_from" = '2026-09-13',
    "start_time" = '09:00',
    "end_time" = '18:00',
    "title" = 'Claude Code Impact Lab 2',
    "short_title" = 'Impact Lab 2',
    "updated_at" = now()
WHERE "slug" = 'claude-impact-lab-september'
  AND "source_id" IS NULL
  AND "date" = '2026-09-13';
--> statement-breakpoint
-- The Conversation's copy said the Lab ran "the next day"; after the move it
-- did not. Only the exact old sentence on that one event is rewritten.
UPDATE "events"
SET "description" = 'A small, focused evening for founders and builders around one question. The room picks a real problem worth solving — and the Impact Lab builds the answer.',
    "updated_at" = now()
WHERE "slug" = 'claude-conversation-september'
  AND "description" = 'A small, focused evening for founders and builders around one question. The room picks a real problem worth solving — and the Impact Lab spends the next day building the answer.';
--> statement-breakpoint
-- The Bhopal Fable 5.1 Build Day is a Luma-ingested row; its badge label is
-- editorial and survives feed updates because ingestion never writes it.
UPDATE "events" e
SET "short_title" = 'Fable 5.1 Build Day'
FROM "event_sources" s
WHERE e."source_id" = s."id"
  AND s."key" = 'luma:claudecommunity'
  AND e."external_id" = 'evt-4zpHOs9YWXolVLg'
  AND e."short_title" IS NULL;
