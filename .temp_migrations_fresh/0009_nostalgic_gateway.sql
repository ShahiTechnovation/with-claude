ALTER TABLE "builders" ADD COLUMN "moderation_state" "moderation_state" DEFAULT 'clean' NOT NULL;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "builders" ADD CONSTRAINT "builders_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;