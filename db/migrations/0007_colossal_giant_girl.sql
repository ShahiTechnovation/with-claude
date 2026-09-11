CREATE TYPE "public"."project_member_role" AS ENUM('collaborator', 'contributor');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('draft', 'published', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."moderation_state" AS ENUM('clean', 'reported', 'restricted', 'archived');--> statement-breakpoint
CREATE TYPE "public"."media_status" AS ENUM('staged', 'published', 'deleted');--> statement-breakpoint

CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"role" "project_member_role" DEFAULT 'collaborator' NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_member_id_pk" PRIMARY KEY("project_id","member_id")
);
--> statement-breakpoint

ALTER TABLE "media" ALTER COLUMN "path" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "blob_url" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "pathname" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "size_bytes" integer;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "caption" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "credit" text;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "status" "media_status" DEFAULT 'published' NOT NULL;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

ALTER TABLE "projects" ADD COLUMN "owner_member_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "publication_status" "publication_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "moderation_state" "moderation_state" DEFAULT 'clean' NOT NULL;--> statement-breakpoint

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "media" ADD CONSTRAINT "media_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "projects_publication_idx" ON "projects" USING btree ("publication_status");--> statement-breakpoint
CREATE INDEX "projects_moderation_idx" ON "projects" USING btree ("moderation_state");--> statement-breakpoint

DO $$ 
DECLARE
    r record;
BEGIN
    FOR r IN SELECT id, status FROM "projects"
    LOOP
        IF r.status = 'draft' THEN
            UPDATE "projects" SET "publication_status" = 'draft', "moderation_state" = 'clean' WHERE id = r.id;
        ELSIF r.status = 'published' THEN
            UPDATE "projects" SET "publication_status" = 'published', "moderation_state" = 'clean' WHERE id = r.id;
        ELSIF r.status = 'archived' THEN
            UPDATE "projects" SET "publication_status" = 'archived', "moderation_state" = 'archived' WHERE id = r.id;
        ELSE
            RAISE EXCEPTION 'Unexpected legacy status % for project %', r.status, r.id;
        END IF;
    END LOOP;
END $$;