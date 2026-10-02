CREATE TYPE "public"."content_authority" AS ENUM('member', 'curated', 'baserow');--> statement-breakpoint
CREATE TABLE "project_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"role" text,
	"public_url" text,
	"position" smallint DEFAULT 0 NOT NULL,
	"builder_id" uuid,
	"source_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_credits_name_present" CHECK (length(trim("project_credits"."display_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "featured_order" smallint;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "content_authority" "content_authority" DEFAULT 'curated' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_credits" ADD CONSTRAINT "project_credits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_credits" ADD CONSTRAINT "project_credits_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_credits_project_idx" ON "project_credits" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "project_credits_source_unique" ON "project_credits" USING btree ("source_key") WHERE "project_credits"."source_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_builders_builder_idx" ON "project_builders" USING btree ("builder_id");--> statement-breakpoint
CREATE INDEX "project_members_member_idx" ON "project_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "projects_public_recent_idx" ON "projects" USING btree ("published_at","slug") WHERE publication_status = 'published' AND moderation_state = 'clean' AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_member_id");--> statement-breakpoint
-- ── DATA: who may write each existing project ──────────────────────────────
-- Every project a member created is the website's to edit. Everything else
-- (the curated archive, admin promotions) stays `curated`, the fail-closed
-- default.
UPDATE "projects" SET "content_authority" = 'member' WHERE "owner_member_id" IS NOT NULL;
--> statement-breakpoint
-- ── DATA: a real "first went public" time for member projects ──────────────
-- The earliest `project.published` audit entry is the evidenced moment; a
-- published row without one falls back to its last update. Curated rows keep
-- NULL: their real date is unknown and is not guessed.
UPDATE "projects" p SET "published_at" = COALESCE(
  (SELECT min(a."created_at") FROM "audit_log" a
    WHERE a."entity_type" = 'project' AND a."entity_id" = p."id" AND a."action" = 'project.published'),
  p."updated_at")
WHERE p."publication_status" = 'published' AND p."published_at" IS NULL AND p."owner_member_id" IS NOT NULL;
--> statement-breakpoint
-- ── DATA: the legacy `status` column follows `publication_status` ──────────
-- Member projects only. The archive/restore routes used to move one column
-- and not the other.
UPDATE "projects" SET "status" = (CASE "publication_status"
    WHEN 'published' THEN 'published'
    WHEN 'draft' THEN 'draft'
    ELSE 'archived' END)::"content_status"
WHERE "owner_member_id" IS NOT NULL;
--> statement-breakpoint
-- ── DATA: an admin takedown that never took effect ─────────────────────────
-- The admin's Archive action moved only `status`, while every public reader
-- filters on `publication_status` — so an archived curated project stayed on
-- the website. This applies the takedown the editor already recorded. (The
-- opposite mismatch — admin-published but still `draft` — is NOT applied
-- here, because it would publish content; see docs/runbook-rollout.md.)
UPDATE "projects" SET "publication_status" = 'archived'
WHERE "content_authority" = 'curated' AND "status" = 'archived' AND "publication_status" = 'published';
--> statement-breakpoint
-- ── DATA: covers become media references ───────────────────────────────────
-- A cover uploaded through the authorised flow has a media row for the same
-- project and URL; link it. An `image_path` URL with no such row is left
-- as-is and is no longer rendered (see src/server/media/covers.ts).
UPDATE "projects" p SET "image_id" = m."id"
FROM "media" m
WHERE p."image_id" IS NULL AND m."project_id" = p."id" AND m."blob_url" = p."image_path" AND m."status" <> 'deleted';
--> statement-breakpoint
UPDATE "media" m SET "status" = 'published', "updated_at" = now()
FROM "projects" p
WHERE p."image_id" = m."id" AND p."publication_status" = 'published' AND m."status" = 'staged';
