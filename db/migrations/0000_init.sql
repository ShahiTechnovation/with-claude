CREATE TYPE "public"."content_status" AS ENUM('draft', 'pending', 'in_review', 'changes_requested', 'approved', 'published', 'rejected', 'archived');--> statement-breakpoint
CREATE TYPE "public"."event_format" AS ENUM('conversation', 'workshop', 'impact-lab', 'campus', 'hackathon', 'demo', 'meetup', 'other');--> statement-breakpoint
CREATE TYPE "public"."event_status_override" AS ENUM('sold-out', 'registration-closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."link_owner" AS ENUM('builder', 'ambassador', 'city');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('photo', 'cover', 'portrait', 'logo', 'other');--> statement-breakpoint
CREATE TYPE "public"."project_category" AS ENUM('product', 'agent', 'developer-tool', 'research', 'creative', 'campus', 'experiment', 'startup');--> statement-breakpoint
CREATE TYPE "public"."source_owner" AS ENUM('use_case', 'guide');--> statement-breakpoint
CREATE TYPE "public"."story_kind" AS ENUM('recap', 'profile', 'project-story', 'city-story', 'photo-essay', 'lesson', 'experiment');--> statement-breakpoint
CREATE TYPE "public"."submission_kind" AS ENUM('builder', 'project', 'use-case', 'city-interest');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('received', 'in_review', 'accepted', 'rejected', 'spam');--> statement-breakpoint
CREATE TYPE "public"."use_case_category" AS ENUM('claude-code', 'product', 'startups', 'research', 'design', 'education', 'operations', 'marketing', 'automation', 'agents', 'developer-workflows');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('viewer', 'reviewer', 'editor', 'admin');--> statement-breakpoint
CREATE TYPE "public"."workflow_actor" AS ENUM('human', 'claude', 'both');--> statement-breakpoint
CREATE TABLE "ambassadors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"city_id" uuid NOT NULL,
	"title" text DEFAULT 'Claude Community Ambassador' NOT NULL,
	"verified_via" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"builder_id" uuid,
	"since" date,
	"bio" text,
	"image_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ambassadors_slug_unique" UNIQUE("slug"),
	CONSTRAINT "ambassadors_verified_via_present" CHECK (length(trim("ambassadors"."verified_via")) > 0),
	CONSTRAINT "ambassadors_title_verbatim" CHECK ("ambassadors"."title" = 'Claude Community Ambassador')
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "builders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"city_id" uuid NOT NULL,
	"role" text NOT NULL,
	"roles" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"bio" text,
	"building" text,
	"claude_tools" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"image_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "builders_slug_unique" UNIQUE("slug"),
	CONSTRAINT "builders_roles_exclude_ambassador" CHECK (NOT ("builders"."roles" @> ARRAY['ambassador']))
);
--> statement-breakpoint
CREATE TABLE "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"blurb" text NOT NULL,
	"interest_count" integer,
	"interest_source" text,
	"reported_members" integer,
	"reported_prototypes" integer,
	"reported_source" text,
	"organiser_id" uuid,
	"image_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "cities_slug_unique" UNIQUE("slug"),
	CONSTRAINT "cities_reported_needs_source" CHECK (("cities"."reported_members" IS NULL AND "cities"."reported_prototypes" IS NULL)
          OR "cities"."reported_source" IS NOT NULL),
	CONSTRAINT "cities_interest_needs_source" CHECK ("cities"."interest_count" IS NULL OR "cities"."interest_source" IS NOT NULL),
	CONSTRAINT "cities_lat_range" CHECK ("cities"."lat" BETWEEN -90 AND 90),
	CONSTRAINT "cities_lon_range" CHECK ("cities"."lon" BETWEEN -180 AND 180)
);
--> statement-breakpoint
CREATE TABLE "city_interest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_name" text NOT NULL,
	"city_id" uuid,
	"email" text NOT NULL,
	"doing" text,
	"helping" text,
	"submission_id" uuid,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "city_interest_verified_has_verifier" CHECK ("city_interest"."verified_at" IS NULL OR "city_interest"."verified_by" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "event_agenda_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"time" time,
	"title" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "event_co_hosts" (
	"event_id" uuid NOT NULL,
	"builder_id" uuid NOT NULL,
	CONSTRAINT "event_co_hosts_event_id_builder_id_pk" PRIMARY KEY("event_id","builder_id")
);
--> statement-breakpoint
CREATE TABLE "event_organizations" (
	"event_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "event_organizations_event_id_organization_id_pk" PRIMARY KEY("event_id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "event_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_photos" (
	"event_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	CONSTRAINT "event_photos_event_id_media_id_pk" PRIMARY KEY("event_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "event_speakers" (
	"event_id" uuid NOT NULL,
	"builder_id" uuid NOT NULL,
	CONSTRAINT "event_speakers_event_id_builder_id_pk" PRIMARY KEY("event_id","builder_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"format" "event_format" NOT NULL,
	"volume" smallint,
	"city_id" uuid NOT NULL,
	"ambassador_id" uuid,
	"date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time,
	"venue_name" text NOT NULL,
	"venue_address" text,
	"venue_private" boolean DEFAULT false NOT NULL,
	"summary" text NOT NULL,
	"description" text,
	"registration_url" text,
	"status_override" "event_status_override",
	"free" boolean DEFAULT true NOT NULL,
	"cover_image_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "events_slug_unique" UNIQUE("slug"),
	CONSTRAINT "events_volume_positive" CHECK ("events"."volume" IS NULL OR "events"."volume" > 0),
	CONSTRAINT "events_end_after_start" CHECK ("events"."end_time" IS NULL OR "events"."end_time" > "events"."start_time")
);
--> statement-breakpoint
CREATE TABLE "guide_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guide_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"heading" text,
	"paragraphs" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"question" text NOT NULL,
	"standfirst" text NOT NULL,
	"author_builder_id" uuid,
	"author_name" text,
	"author_credential" text NOT NULL,
	"published" date NOT NULL,
	"modified" date,
	"reading_minutes" smallint,
	"image_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "guides_slug_unique" UNIQUE("slug"),
	CONSTRAINT "guides_credential_present" CHECK (length(trim("guides"."author_credential")) > 0),
	CONSTRAINT "guides_author_identified" CHECK ("guides"."author_builder_id" IS NOT NULL OR "guides"."author_name" IS NOT NULL),
	CONSTRAINT "guides_modified_after_published" CHECK ("guides"."modified" IS NULL OR "guides"."modified" >= "guides"."published")
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"alt" text NOT NULL,
	"kind" "media_kind" DEFAULT 'other' NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_path_unique" UNIQUE("path")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug"),
	CONSTRAINT "organizations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "project_builders" (
	"project_id" uuid NOT NULL,
	"builder_id" uuid NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "project_builders_project_id_builder_id_pk" PRIMARY KEY("project_id","builder_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"city_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"description" text,
	"category" "project_category" NOT NULL,
	"url" text,
	"repo_url" text,
	"video_url" text,
	"image_id" uuid,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"claude_usage" text,
	"built_at_event_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "social_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "link_owner" NOT NULL,
	"owner_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" "source_owner" NOT NULL,
	"owner_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"label" text NOT NULL,
	"url" text,
	"retrieved" date
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"standfirst" text NOT NULL,
	"kind" "story_kind" NOT NULL,
	"date" date NOT NULL,
	"city_id" uuid,
	"author" text,
	"image_id" uuid,
	"event_id" uuid,
	"reading_minutes" smallint,
	"body" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "stories_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "story_builders" (
	"story_id" uuid NOT NULL,
	"builder_id" uuid NOT NULL,
	CONSTRAINT "story_builders_story_id_builder_id_pk" PRIMARY KEY("story_id","builder_id")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "submission_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"submitter_name" text,
	"submitter_email" text NOT NULL,
	"submitter_user_id" uuid,
	"status" "submission_status" DEFAULT 'received' NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"reviewer_id" uuid,
	"reviewer_note" text,
	"reviewed_at" timestamp with time zone,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_reviewed_has_reviewer" CHECK ("submissions"."reviewed_at" IS NULL OR "submissions"."reviewer_id" IS NOT NULL),
	CONSTRAINT "submissions_entity_pair" CHECK (("submissions"."entity_type" IS NULL) = ("submissions"."entity_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "use_case_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"use_case_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"label" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "use_case_workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"use_case_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"by" "workflow_actor" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "use_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"category" "use_case_category" NOT NULL,
	"author_builder_id" uuid,
	"author_name" text,
	"author_credential" text NOT NULL,
	"city_id" uuid,
	"date" date NOT NULL,
	"problem" text NOT NULL,
	"context" text NOT NULL,
	"claude_did" text[] NOT NULL,
	"human_did" text[] NOT NULL,
	"tools" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"result" text NOT NULL,
	"image_id" uuid,
	"project_id" uuid,
	"event_id" uuid,
	"status" "content_status" DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	CONSTRAINT "use_cases_slug_unique" UNIQUE("slug"),
	CONSTRAINT "use_cases_credential_present" CHECK (length(trim("use_cases"."author_credential")) > 0),
	CONSTRAINT "use_cases_author_identified" CHECK ("use_cases"."author_builder_id" IS NOT NULL OR "use_cases"."author_name" IS NOT NULL),
	CONSTRAINT "use_cases_both_sides_present" CHECK (cardinality("use_cases"."claude_did") > 0 AND cardinality("use_cases"."human_did") > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "ambassadors" ADD CONSTRAINT "ambassadors_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD CONSTRAINT "ambassadors_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD CONSTRAINT "ambassadors_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD CONSTRAINT "ambassadors_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builders" ADD CONSTRAINT "builders_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "builders" ADD CONSTRAINT "builders_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_organiser_id_organizations_id_fk" FOREIGN KEY ("organiser_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_interest" ADD CONSTRAINT "city_interest_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_interest" ADD CONSTRAINT "city_interest_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_interest" ADD CONSTRAINT "city_interest_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_agenda_items" ADD CONSTRAINT "event_agenda_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_co_hosts" ADD CONSTRAINT "event_co_hosts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_co_hosts" ADD CONSTRAINT "event_co_hosts_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_organizations" ADD CONSTRAINT "event_organizations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_organizations" ADD CONSTRAINT "event_organizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_outcomes" ADD CONSTRAINT "event_outcomes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_photos" ADD CONSTRAINT "event_photos_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_photos" ADD CONSTRAINT "event_photos_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_speakers" ADD CONSTRAINT "event_speakers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_speakers" ADD CONSTRAINT "event_speakers_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_ambassador_id_ambassadors_id_fk" FOREIGN KEY ("ambassador_id") REFERENCES "public"."ambassadors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_cover_image_id_media_id_fk" FOREIGN KEY ("cover_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide_sections" ADD CONSTRAINT "guide_sections_guide_id_guides_id_fk" FOREIGN KEY ("guide_id") REFERENCES "public"."guides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guides" ADD CONSTRAINT "guides_author_builder_id_builders_id_fk" FOREIGN KEY ("author_builder_id") REFERENCES "public"."builders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guides" ADD CONSTRAINT "guides_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_builders" ADD CONSTRAINT "project_builders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_builders" ADD CONSTRAINT "project_builders_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_built_at_event_id_events_id_fk" FOREIGN KEY ("built_at_event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_builders" ADD CONSTRAINT "story_builders_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_builders" ADD CONSTRAINT "story_builders_builder_id_builders_id_fk" FOREIGN KEY ("builder_id") REFERENCES "public"."builders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitter_user_id_users_id_fk" FOREIGN KEY ("submitter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_case_artifacts" ADD CONSTRAINT "use_case_artifacts_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_case_workflow_steps" ADD CONSTRAINT "use_case_workflow_steps_use_case_id_use_cases_id_fk" FOREIGN KEY ("use_case_id") REFERENCES "public"."use_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_cases" ADD CONSTRAINT "use_cases_author_builder_id_builders_id_fk" FOREIGN KEY ("author_builder_id") REFERENCES "public"."builders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_cases" ADD CONSTRAINT "use_cases_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_cases" ADD CONSTRAINT "use_cases_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_cases" ADD CONSTRAINT "use_cases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "use_cases" ADD CONSTRAINT "use_cases_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ambassadors_builder_unique" ON "ambassadors" USING btree ("builder_id");--> statement-breakpoint
CREATE INDEX "ambassadors_city_idx" ON "ambassadors" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "builders_city_idx" ON "builders" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "builders_status_idx" ON "builders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cities_status_idx" ON "cities" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "city_interest_email_city_unique" ON "city_interest" USING btree ("email","city_name");--> statement-breakpoint
CREATE INDEX "city_interest_city_idx" ON "city_interest" USING btree ("city_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_agenda_position_unique" ON "event_agenda_items" USING btree ("event_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "event_outcome_position_unique" ON "event_outcomes" USING btree ("event_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "event_photo_position_unique" ON "event_photos" USING btree ("event_id","position");--> statement-breakpoint
CREATE INDEX "events_city_idx" ON "events" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "events_date_idx" ON "events" USING btree ("date");--> statement-breakpoint
CREATE INDEX "events_status_idx" ON "events" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "guide_section_position_unique" ON "guide_sections" USING btree ("guide_id","position");--> statement-breakpoint
CREATE INDEX "projects_city_idx" ON "projects" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "projects_event_idx" ON "projects" USING btree ("built_at_event_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "link_position_unique" ON "social_links" USING btree ("owner_type","owner_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "source_position_unique" ON "sources" USING btree ("owner_type","owner_id","position");--> statement-breakpoint
CREATE INDEX "stories_city_idx" ON "stories" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "submissions_status_idx" ON "submissions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "submissions_kind_idx" ON "submissions" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "submissions_created_idx" ON "submissions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "submissions_ip_created_idx" ON "submissions" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "submissions_email_created_idx" ON "submissions" USING btree ("submitter_email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "use_case_artifact_position_unique" ON "use_case_artifacts" USING btree ("use_case_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "use_case_step_position_unique" ON "use_case_workflow_steps" USING btree ("use_case_id","position");--> statement-breakpoint
CREATE INDEX "use_cases_author_idx" ON "use_cases" USING btree ("author_builder_id");--> statement-breakpoint
CREATE INDEX "use_cases_status_idx" ON "use_cases" USING btree ("status");