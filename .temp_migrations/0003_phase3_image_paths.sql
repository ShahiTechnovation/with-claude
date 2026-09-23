-- Phase 3 — the image paths the record already holds.
--
-- ── WHY THIS MIGRATION EXISTS ────────────────────────────────────────────
--
-- Phase 1 imported media for event photos and nothing else, on purpose: an
-- event photo carries authored alt text, and a cover image, a portrait or a
-- city photograph does not. Writing "Cover image for X" into `media.alt`
-- would have been inventing a description of a picture nobody looked at,
-- which is the same failure as inventing a date. So those assets stayed in
-- git, where the image registry resolves them, and the database did not
-- pretend to know about them.
--
-- That was right for Phase 1, where nothing read the database. It is wrong
-- for Phase 3, where the database becomes the read source for the public
-- build: a `DATA_SOURCE=db` build would render every page with its
-- photography missing, and no amount of reader code can fix data that is not
-- there.
--
-- ── WHY A PATH COLUMN RATHER THAN A MEDIA ROW ────────────────────────────
--
-- `media.alt` is NOT NULL and must stay that way — see the schema header.
-- Making it nullable to fit these images would weaken the one constraint that
-- keeps undescribed pictures from becoming normal, and would do it for every
-- image on the site rather than only these.
--
-- So the asset reference and the described-image table stay separate things.
-- `image_path` is exactly what `src/data/*.ts` holds today: a path under
-- `src/assets` that `asset()` in `src/lib/images.ts` resolves at build time.
-- It carries no alt text and claims none. The components that render these
-- images already derive their alt from the record — a city photograph is
-- described as "Bhopal, Madhya Pradesh" from the city's own name and region —
-- so nothing here is invented, and nothing here is described by this table.
--
-- Event photos are untouched. They have real alt text, they belong in
-- `media`, and they stay there.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────
--
-- Every column is nullable with no default and no backfill, so this runs
-- against a populated Phase 1/2 database as a pure metadata change: no row is
-- rewritten, no constraint is revalidated, and no existing value is cast.
-- A database that has not been re-imported simply has nulls here, and the
-- reader treats a null path exactly as the TypeScript record treats an absent
-- `image` field — as no image.

ALTER TABLE "cities" ADD COLUMN IF NOT EXISTS "image_path" text;--> statement-breakpoint
ALTER TABLE "builders" ADD COLUMN IF NOT EXISTS "image_path" text;--> statement-breakpoint
ALTER TABLE "ambassadors" ADD COLUMN IF NOT EXISTS "image_path" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "image_path" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "image_path" text;--> statement-breakpoint
ALTER TABLE "use_cases" ADD COLUMN IF NOT EXISTS "image_path" text;--> statement-breakpoint
ALTER TABLE "guides" ADD COLUMN IF NOT EXISTS "image_path" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "cover_image_path" text;
