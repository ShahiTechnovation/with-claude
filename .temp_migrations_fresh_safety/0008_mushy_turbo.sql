CREATE TYPE "public"."report_reason" AS ENUM('spam', 'impersonation', 'harassment', 'misleading', 'stolen_work', 'unsafe_link', 'inappropriate_content', 'copyright', 'duplicate', 'privacy', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_severity" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'triaged', 'investigating', 'resolved', 'dismissed');--> statement-breakpoint
ALTER TYPE "public"."moderation_state" ADD VALUE 'removed';--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_member_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" "report_reason" NOT NULL,
	"details" text,
	"severity" "report_severity" DEFAULT 'low' NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"assigned_moderator_id" uuid,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "media" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_member_id_members_id_fk" FOREIGN KEY ("reporter_member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigned_moderator_id_users_id_fk" FOREIGN KEY ("assigned_moderator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_status_severity_created_idx" ON "reports" USING btree ("status","severity","created_at");--> statement-breakpoint
CREATE INDEX "reports_entity_idx" ON "reports" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_member_id");--> statement-breakpoint
CREATE INDEX "reports_moderator_idx" ON "reports" USING btree ("assigned_moderator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_unique_open" ON "reports" USING btree ("reporter_member_id","entity_type","entity_id") WHERE "reports"."status" = 'open';--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;