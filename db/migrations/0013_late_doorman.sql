CREATE TYPE "public"."event_host_role" AS ENUM('primary_host', 'co_host', 'organizer', 'partner', 'speaker');--> statement-breakpoint
CREATE TYPE "public"."event_host_source" AS ENUM('curated', 'ingest', 'manual');--> statement-breakpoint
CREATE TYPE "public"."event_record_state" AS ENUM('pending', 'promoted', 'review', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."event_sync_mode" AS ENUM('api', 'webhook', 'ics', 'manual');--> statement-breakpoint
CREATE TYPE "public"."event_sync_status" AS ENUM('never', 'ok', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('user', 'moderator');--> statement-breakpoint
CREATE TABLE "event_hosts" (
	"event_id" uuid NOT NULL,
	"ambassador_id" uuid NOT NULL,
	"role" "event_host_role" NOT NULL,
	"source" "event_host_source" NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '1.00' NOT NULL,
	"source_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_hosts_event_id_ambassador_id_role_pk" PRIMARY KEY("event_id","ambassador_id","role"),
	CONSTRAINT "event_hosts_confidence_range" CHECK ("event_hosts"."confidence" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "event_source_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
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
	"sequence" bigint,
	"source_status" text,
	"state" "event_record_state" DEFAULT 'pending' NOT NULL,
	"state_reason" text,
	"india_confidence" smallint,
	"event_id" uuid,
	"city_id" uuid,
	"raw_hash" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"sync_mode" "event_sync_mode" NOT NULL,
	"calendar_id" text,
	"feed_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" "event_sync_status" DEFAULT 'never' NOT NULL,
	"last_sync_message" text,
	"last_seen_count" integer,
	"last_promoted_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_sources_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "city_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "summary" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD COLUMN "luma_profile_url" text;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD COLUMN "luma_external_id" text;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD COLUMN "luma_display_name" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "role" "member_role" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "event_hosts" ADD CONSTRAINT "event_hosts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_hosts" ADD CONSTRAINT "event_hosts_ambassador_id_ambassadors_id_fk" FOREIGN KEY ("ambassador_id") REFERENCES "public"."ambassadors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_source_records" ADD CONSTRAINT "event_source_records_source_id_event_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."event_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_source_records" ADD CONSTRAINT "event_source_records_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_source_records" ADD CONSTRAINT "event_source_records_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_hosts_one_primary" ON "event_hosts" USING btree ("event_id") WHERE role = 'primary_host';--> statement-breakpoint
CREATE INDEX "event_hosts_ambassador_idx" ON "event_hosts" USING btree ("ambassador_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_source_records_identity_unique" ON "event_source_records" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "event_source_records_state_idx" ON "event_source_records" USING btree ("state");--> statement-breakpoint
CREATE INDEX "event_source_records_starts_idx" ON "event_source_records" USING btree ("starts_at");--> statement-breakpoint
ALTER TABLE "ambassadors" ADD CONSTRAINT "ambassadors_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_source_id_event_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."event_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ambassadors_member_unique" ON "ambassadors" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ambassadors_luma_external_unique" ON "ambassadors" USING btree ("luma_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ambassadors_luma_display_name_unique" ON "ambassadors" USING btree (lower(btrim("luma_display_name"))) WHERE "ambassadors"."luma_display_name" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_external_unique" ON "events" USING btree ("source_id","external_id") WHERE "events"."source_id" IS NOT NULL AND "events"."external_id" IS NOT NULL;