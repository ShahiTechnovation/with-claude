CREATE TYPE "public"."import_batch_status" AS ENUM('planned', 'applying', 'applied', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."import_ledger_status" AS ENUM('pending', 'applied', 'failed', 'skipped', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."integration_entity" AS ENUM('event', 'project', 'project_credit', 'city');--> statement-breakpoint
CREATE TYPE "public"."integration_job_status" AS ENUM('pending', 'running', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."integration_mapping_status" AS ENUM('active', 'quarantined', 'tombstoned', 'released');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('baserow');--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"source_file" text NOT NULL,
	"checksum" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"status" "import_batch_status" DEFAULT 'planned' NOT NULL,
	"report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_crosswalk" (
	"candidate_key" text PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"baserow_table_id" integer,
	"baserow_row_id" integer,
	"first_batch_id" uuid,
	"last_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"action" text NOT NULL,
	"table_id" integer NOT NULL,
	"row_id" integer,
	"before" jsonb,
	"after" jsonb,
	"after_hash" text,
	"status" "import_ledger_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"kind" text NOT NULL,
	"table_id" integer NOT NULL,
	"row_id" integer,
	"dedupe_key" text NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"status" "integration_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"table_id" integer NOT NULL,
	"row_id" integer NOT NULL,
	"entity_type" "integration_entity" NOT NULL,
	"entity_id" uuid,
	"content_hash" text,
	"source_hash" text,
	"status" "integration_mapping_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_applied_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"evidence" text NOT NULL,
	"status" "claim_status" DEFAULT 'pending' NOT NULL,
	"resolution_note" text,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "project_claims_evidence_present" CHECK (length(trim("project_claims"."evidence")) >= 10)
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "content_authority" "content_authority" DEFAULT 'curated' NOT NULL;--> statement-breakpoint
ALTER TABLE "import_crosswalk" ADD CONSTRAINT "import_crosswalk_first_batch_id_import_batches_id_fk" FOREIGN KEY ("first_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_crosswalk" ADD CONSTRAINT "import_crosswalk_last_batch_id_import_batches_id_fk" FOREIGN KEY ("last_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_ledger" ADD CONSTRAINT "import_ledger_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_claims" ADD CONSTRAINT "project_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_claims" ADD CONSTRAINT "project_claims_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_claims" ADD CONSTRAINT "project_claims_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_crosswalk_event_idx" ON "import_crosswalk" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "import_ledger_batch_idx" ON "import_ledger" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_ledger_once" ON "import_ledger" USING btree ("batch_id","candidate_key","action","table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_jobs_pending_dedupe" ON "integration_jobs" USING btree ("dedupe_key") WHERE "integration_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "integration_jobs_ready_idx" ON "integration_jobs" USING btree ("status","priority","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_mappings_identity_unique" ON "integration_mappings" USING btree ("provider","table_id","row_id");--> statement-breakpoint
CREATE INDEX "integration_mappings_entity_idx" ON "integration_mappings" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "integration_mappings_status_idx" ON "integration_mappings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "integration_runs_started_idx" ON "integration_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_claims_one_approved" ON "project_claims" USING btree ("project_id") WHERE "project_claims"."status" = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "project_claims_one_open_per_member" ON "project_claims" USING btree ("project_id","member_id") WHERE "project_claims"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "project_claims_status_idx" ON "project_claims" USING btree ("status");