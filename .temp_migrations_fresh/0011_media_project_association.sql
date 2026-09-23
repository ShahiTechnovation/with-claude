-- ============================================================================
-- 0011 — Media belongs to a project.
--
-- ADDITIVE ONLY. One nullable column, one foreign key, one index.
--
-- Section 12 requires that an uploaded image record carry `project_id`
-- alongside `owner_member_id`, and that the association be VALIDATED. Neither
-- was possible: `media` had no such column, so `POST /api/media/upload` wrote
-- a row that recorded who uploaded a file and nothing about what it was for.
-- The practical consequence is that an uploaded cover image could not be
-- attached to the project it was uploaded from, and orphaned blobs could not
-- be distinguished from in-use ones.
--
-- NULLABLE, and deliberately so. The curated archive's media — every event
-- photo and city picture already in this table — has no project and never
-- will, and an avatar has a member but no project either. A NOT NULL column
-- would have required inventing a project for all of them.
-- ============================================================================

ALTER TABLE "media" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Deleting a project takes its uploaded media rows with it (ON DELETE cascade
-- above), which is why this is the one foreign key here that cascades rather
-- than setting null: a media row whose only purpose was one project has no
-- meaning once that project is gone. The blob itself is a separate concern.
CREATE INDEX "media_project_idx" ON "media" ("project_id");--> statement-breakpoint
CREATE INDEX "media_owner_member_idx" ON "media" ("owner_member_id");
