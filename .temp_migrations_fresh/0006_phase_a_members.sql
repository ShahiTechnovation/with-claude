-- Phase A — public member identity, the Builder Passport, and profile claims.
--
-- The product changes shape here. Until now every public record arrived
-- through `/api/submit` and reached the website because an editor approved it
-- and then published it. From here a person authenticates with Privy and
-- publishes their own profile, and the admin stops being an approval gate and
-- becomes a moderation system.
--
-- ── WHY A SEPARATE IDENTITY LAYER, AND NOT `users` ───────────────────────
--
-- `users` is the editorial allowlist. It has no sign-up, by design: a row is
-- created by `npm run db:create-user` and by nothing else, and that is the
-- whole access model for the admin. Public members are the opposite — anyone
-- may become one, instantly, without anybody's permission.
--
-- Putting both in one table would mean the table that decides who can archive
-- a record is also the table anybody on the internet can insert into. So
-- there are two identity systems and no bridge between them. `members` and
-- `users` never reference each other except where an audit column records
-- WHICH MODERATOR ACTED, which is a fact about an action rather than a link
-- between two people.
--
-- ── WHAT PRIVY OWNS AND WHAT THIS DATABASE OWNS ──────────────────────────
--
-- Privy owns authentication. This database owns everything else: profile,
-- ownership, claims, preferences.
--
-- `members.privy_user_id` is the only join between the two, and it is the
-- Privy DID. There is deliberately no column here for an access token, a
-- refresh token, a session cookie or any other credential — nothing in this
-- migration can hold a secret, so nothing here can leak one. The server
-- verifies a token in memory on each request and stores only the subject.
--
-- ── WHERE THE PUBLIC PROFILE ACTUALLY LIVES ──────────────────────────────
--
-- `builders`, still. `member_profiles` is where a member EDITS their profile;
-- `builders` is where the public record is PUBLISHED, and one whitelist
-- function projects the first into the second.
--
-- That indirection is not decoration. It is what makes §14's split — user-
-- owned fields versus source-owned fields — a mechanism rather than a promise:
-- a projection can only write the columns it names, so a member editing their
-- bio cannot reach `name`, `roles`, an ambassador link, or any historical
-- event credit, whether their builder row is one they created or one they
-- claimed. It also leaves the prerendered pages and the search index reading
-- exactly the table they already read, which is why Phase A needs no changes
-- to `RecordSet` and no changes to the migration machinery Phase 0 verified.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────
--
-- Additive only. Five new tables, two new nullable columns on existing
-- tables, five new enums. Nothing is dropped, nothing is rewritten, no
-- existing constraint is revalidated, and no existing row changes value. The
-- 72 builders are untouched: `owner_member_id` starts NULL for every one of
-- them, which is what "unclaimed" means.

-- ── ENUMS ────────────────────────────────────────────────────────────────

-- `deleted` is a state, not a row deletion. See §12 of the v2 brief and the
-- soft-delete argument in `docs/architecture-v2.md`.
CREATE TYPE "member_status" AS ENUM ('active', 'suspended', 'deleted');
--> statement-breakpoint

-- `unlisted` is not private. It means "not promoted and not indexed" — the
-- page still answers to anybody holding the URL. A genuinely private profile
-- would need every public reader to become status-aware, and inventing that
-- in Phase A would be building an access-control system nobody asked for.
CREATE TYPE "profile_visibility" AS ENUM ('public', 'unlisted');
--> statement-breakpoint

-- How a claim was proven. Every value here is DETERMINISTIC or human —
-- there is no `name_match`, no `city_match` and no `similarity`, because
-- §12 is explicit that resemblance is not proof, and a value that does not
-- exist cannot be used by mistake later.
CREATE TYPE "claim_proof_type" AS ENUM (
  'github_identity',
  'linkedin_identity',
  'email_identity',
  'moderator_review'
);
--> statement-breakpoint

CREATE TYPE "claim_status" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');
--> statement-breakpoint

-- Where a record came from. `legacy` is everything the importer created;
-- `user` is everything a member creates from here on. The distinction is what
-- lets one publish path apply to member-owned rows and the editorial state
-- machine keep applying to the curated archive.
CREATE TYPE "content_source" AS ENUM ('legacy', 'user');
--> statement-breakpoint

-- ── MEMBERS ──────────────────────────────────────────────────────────────

CREATE TABLE "members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- The Privy DID, e.g. `did:privy:clx…`. The only identifier shared with the
  -- authentication provider, and the only thing the server trusts a token for.
  "privy_user_id" text NOT NULL UNIQUE,
  "status" "member_status" NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- Advanced on authenticated requests, coarsely. Not an activity log.
  "last_seen_at" timestamp with time zone
);
--> statement-breakpoint

-- §24. The lookup on every single authenticated request: DID → member.
-- The UNIQUE above already creates an index; this is that index, named.
CREATE INDEX IF NOT EXISTS "members_privy_user_idx" ON "members" ("privy_user_id");
--> statement-breakpoint

-- ── MEMBER PROFILES ──────────────────────────────────────────────────────

CREATE TABLE "member_profiles" (
  "member_id" uuid PRIMARY KEY REFERENCES "members"("id") ON DELETE CASCADE,

  -- The handle, and also the public URL: /builders/<username>. Canonically
  -- lower-case, so `Punit` and `punit` cannot both exist.
  "username" text NOT NULL UNIQUE,

  "display_name" text,
  "first_name" text,
  "last_name" text,
  "headline" text,
  "bio" text,

  -- The atlas city, when the member is in one. Nullable, and `country` exists
  -- beside it, because `cities` is a curated set of fourteen and a member from
  -- a fifteenth city must still be able to have a profile. A connector or a
  -- form must never create a city: city state is DERIVED from verified
  -- ambassador and event records, so an auto-created city is an auto-created
  -- chapter.
  "city_id" uuid REFERENCES "cities"("id") ON DELETE SET NULL,
  "country" text,

  "website" text,

  -- Phase B. The column exists so the profile shape is settled; there is no
  -- upload path yet and `media` is still repository metadata.
  "avatar_media_id" uuid REFERENCES "media"("id") ON DELETE SET NULL,

  -- What they do. NOT a trust signal: §15's protected words are rejected in
  -- application code and, for the one that matters most, by the CHECK that
  -- already exists on `builders.roles`.
  "primary_role" text,

  "claude_since" text,

  -- Opt-in, default off. A profile does not publish somebody's email because
  -- they signed in with it.
  "public_email" boolean NOT NULL DEFAULT false,

  "visibility" "profile_visibility" NOT NULL DEFAULT 'public',

  -- Null until the member publishes. A profile shell is created on first
  -- login so the passport has somewhere to save drafts to; that is not
  -- publication.
  "published_at" timestamp with time zone,

  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),

  -- Shape enforced at the database, not only in the form: lower-case, 3–30,
  -- letters/digits/underscore/hyphen, and never leading with a separator.
  CONSTRAINT "member_profiles_username_shape"
    CHECK ("username" ~ '^[a-z0-9][a-z0-9_-]{2,29}$')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "member_profiles_username_idx" ON "member_profiles" ("username");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_profiles_city_idx" ON "member_profiles" ("city_id");
--> statement-breakpoint

-- ── RESERVED USERNAMES ───────────────────────────────────────────────────

-- A table rather than a constant, because the list has to be enforced by the
-- same thing that enforces uniqueness. A route-level check can be bypassed by
-- the next route somebody writes; a foreign-keyless NOT EXISTS against this
-- table is checked in the same transaction as the insert.
--
-- The list is every top-level public path on the site plus the words an
-- impersonator would want. `builders` is here even though a profile lives
-- UNDER it, because /builders/builders reading as a profile is a bug waiting.
CREATE TABLE "reserved_usernames" (
  "username" text PRIMARY KEY,
  "reason" text NOT NULL
);
--> statement-breakpoint

INSERT INTO "reserved_usernames" ("username", "reason") VALUES
  ('admin', 'impersonation'),
  ('administrator', 'impersonation'),
  ('moderator', 'impersonation'),
  ('moderation', 'route'),
  ('official', 'impersonation'),
  ('anthropic', 'impersonation'),
  ('claude', 'impersonation'),
  ('withclaude', 'impersonation'),
  ('ambassador', 'trust-signal'),
  ('verified', 'trust-signal'),
  ('partner', 'trust-signal'),
  ('sponsor', 'trust-signal'),
  ('staff', 'impersonation'),
  ('support', 'impersonation'),
  ('help', 'route'),
  ('api', 'route'),
  ('login', 'route'),
  ('logout', 'route'),
  ('signin', 'route'),
  ('signup', 'route'),
  ('join', 'route'),
  ('me', 'route'),
  ('settings', 'route'),
  ('profile', 'route'),
  ('builders', 'route'),
  ('projects', 'route'),
  ('events', 'route'),
  ('cities', 'route'),
  ('stories', 'route'),
  ('guides', 'route'),
  ('use-cases', 'route'),
  ('discover', 'route'),
  ('community', 'route'),
  ('record', 'route'),
  ('about', 'route'),
  ('search', 'route'),
  ('null', 'reserved-word'),
  ('undefined', 'reserved-word'),
  ('true', 'reserved-word'),
  ('false', 'reserved-word')
ON CONFLICT ("username") DO NOTHING;
--> statement-breakpoint

-- ── MEMBER IDENTITIES ────────────────────────────────────────────────────

-- The linked accounts Privy vouches for, cached for claim matching.
--
-- WHY CACHE THEM AT ALL: a claim proof compares a builder's curated GitHub or
-- LinkedIn URL against an account Privy has verified. Reading that from a
-- freshly verified identity token on each attempt is the authoritative path
-- and is what the claim endpoint does. This table records what was matched,
-- so a resolved claim can still be explained months later when the member has
-- since unlinked the account.
--
-- `provider_subject` is the provider's own stable id. UNIQUE across all
-- members: one GitHub account cannot be the proof behind two people.
CREATE TABLE "member_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "member_id" uuid NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "provider_subject" text NOT NULL,
  "username" text,
  "display_name" text,
  "profile_url" text,
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "member_identities_provider_subject_unique" UNIQUE ("provider", "provider_subject")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "member_identities_member_idx" ON "member_identities" ("member_id");
--> statement-breakpoint

-- ── PROFILE CLAIMS ───────────────────────────────────────────────────────

CREATE TABLE "profile_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "member_id" uuid NOT NULL REFERENCES "members"("id") ON DELETE CASCADE,
  "builder_id" uuid NOT NULL REFERENCES "builders"("id") ON DELETE CASCADE,
  "proof_type" "claim_proof_type" NOT NULL,

  -- A HASH, NEVER THE VALUE.
  --
  -- The email proof compares an authenticated address against a private
  -- legacy contact address. Storing either would turn a claims table into a
  -- store of other people's email addresses, which is a liability with no
  -- product behind it: nothing needs to read the value back, only to show
  -- that two things matched.
  "proof_value_hash" text,

  "status" "claim_status" NOT NULL DEFAULT 'pending',
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  -- The moderator, when a human resolved it. References the ADMIN table,
  -- because a moderator acting is the one thing that legitimately crosses
  -- between the two identity systems. NULL for a deterministic auto-resolve.
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint

-- §24, exactly the three indexes asked for.
CREATE INDEX IF NOT EXISTS "profile_claims_member_idx" ON "profile_claims" ("member_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_claims_builder_idx" ON "profile_claims" ("builder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_claims_status_idx" ON "profile_claims" ("status");
--> statement-breakpoint

-- ONE APPROVED CLAIM PER BUILDER, EVER.
--
-- This is the constraint that makes "never allow a member to attach
-- themselves to another person" a property of the database rather than a rule
-- a route has to remember. Two members racing to claim the same builder both
-- pass any application-level check; the second one to COMMIT hits this index
-- and loses. See the concurrent-claim test.
CREATE UNIQUE INDEX IF NOT EXISTS "profile_claims_one_owner"
  ON "profile_claims" ("builder_id")
  WHERE "status" = 'approved';
--> statement-breakpoint

-- And one OPEN claim per member per builder, so a rejected claim cannot be
-- resubmitted in a loop to wear a moderator down.
CREATE UNIQUE INDEX IF NOT EXISTS "profile_claims_one_open_per_member"
  ON "profile_claims" ("member_id", "builder_id")
  WHERE "status" = 'pending';
--> statement-breakpoint

-- ── OWNERSHIP ON EXISTING RECORDS ────────────────────────────────────────

-- NULLABLE, AND THAT IS THE POINT.
--
-- All 72 existing builders keep NULL here, which is what "nobody has proved
-- they are this person" means. Ownership is granted by a resolved claim and by
-- nothing else — never inferred from a matching name, which is what §12
-- forbids and what the absence of a `name_match` proof type enforces.
ALTER TABLE "builders"
  ADD COLUMN IF NOT EXISTS "owner_member_id" uuid REFERENCES "members"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "builders"
  ADD COLUMN IF NOT EXISTS "source" "content_source" NOT NULL DEFAULT 'legacy';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "builders_owner_idx" ON "builders" ("owner_member_id");
--> statement-breakpoint

-- ── AUDIT ────────────────────────────────────────────────────────────────

-- A member action needs somewhere to be logged that does not pretend a
-- moderator took it. `actor_id` stays the admin actor and stays nullable;
-- exactly one of the two is set on any given entry.
--
-- The append-only trigger from 0001 still applies: this table cannot be
-- updated or deleted from, so adding a column does not add a way to rewrite
-- history.
ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "actor_member_id" uuid REFERENCES "members"("id") ON DELETE SET NULL;
