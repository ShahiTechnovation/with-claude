CREATE TYPE "public"."member_role" AS ENUM('user', 'moderator', 'owner');
--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "role" "member_role" DEFAULT 'user' NOT NULL;
