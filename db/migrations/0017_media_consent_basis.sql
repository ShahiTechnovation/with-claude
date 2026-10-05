-- ============================================================================
-- 0017 — What `media.consent` means, and the basis beside it.
--
-- ADDITIVE ONLY. One nullable column, then two guarded backfills.
--
-- `media.consent` has existed since 0007 with no stated meaning. Two code
-- paths wrote it (a member uploading their own cover, a member uploading their
-- own portrait) and nothing has ever read it. Every one of the 41 event
-- photographs in this table read `false` — not because a person refused, but
-- because nobody had been asked and `false` is the column default. A column
-- about people that quietly says the wrong thing is only harmless until the
-- first reader trusts it, which is what this migration is for.
--
-- THE MEANING, settled here: `consent` records that THE PERSON SHOWN IN THE
-- IMAGE permitted it to be published here. Never the uploader's opinion of
-- that, and never an organiser's account of someone else's permission. `false`
-- is the absence of a recorded permission, not a refusal.
--
-- THE BASIS. `consent` alone cannot say how far a permission reaches, so
-- `consent_basis` is added beside it and is never left null where `consent` is
-- true. Two bases exist today:
--
--   `self_upload`        — the subject uploaded their own image. The narrowest
--                          basis there is: this image, on this site.
--   `registration_terms` — the subject accepted the event registration terms.
--
-- WHAT THE EVENT PERMISSION IS. Asked of the organiser on VIS-14 and answered
-- on 2026-10-05 (interaction 0622fac1): the permission is text in the online
-- event registration form and its terms; it covers public web use with no end
-- date; and every person who appears in the photographs registered and
-- accepted it. That makes it the same KIND of fact as a self-upload — a
-- permission given by the subject about their own image — which is why it
-- belongs in this column rather than in a separate record of what some
-- third-party release asserts. It is a WIDER permission than a self-upload,
-- which is why the basis is recorded rather than flattened into one boolean.
--
-- The terms themselves have not been read by anyone on this team; the scope
-- above is the organiser's statement of them. Noted here because a migration
-- comment is where the next person will look.
--
-- ALL 76 ROWS MOVE TOGETHER. 41 event photographs are in the table now and are
-- backfilled below; the remaining 35 arrive with the stage-4 event archive, and
-- `db/import/index.ts` now writes the same pair of values on insert and on
-- conflict. There is no state in which one photograph set carries two consent
-- values because two code paths wrote it.
--
-- NOTHING READS `consent` YET. The gallery renders identically before and
-- after this migration. This changes what the database says, not what the site
-- does.
-- ============================================================================

ALTER TABLE "media" ADD COLUMN "consent_basis" text;--> statement-breakpoint

-- ── THE 41 EVENT PHOTOGRAPHS ───────────────────────────────────────────────
-- Addressed by what they are, not by a list of ids: an event photograph is a
-- row whose asset path is under `events/` and whose kind is `photo`, which is
-- exactly what the importer writes and nothing else writes.
--
-- Guarded on `consent_basis IS NULL`, so a re-run changes nothing and a row
-- that already carries a basis is never relabelled.
UPDATE "media"
SET "consent" = true,
    "consent_basis" = 'registration_terms',
    "updated_at" = now()
WHERE "path" LIKE 'events/%'
  AND "kind" = 'photo'
  AND "consent_basis" IS NULL;
--> statement-breakpoint

-- ── THE SELF-UPLOADS ALREADY MARKED TRUE ───────────────────────────────────
-- Runs after the statement above, so every event photograph already has a
-- basis and cannot be caught here. What is left is the rows the two upload
-- paths in `src/server/media/covers.ts` wrote: `consent = true`, owned by the
-- member who uploaded the file. This labels an existing permission; it does
-- not grant one.
--
-- A `consent = true` row with no owning member — none is known — keeps a null
-- basis rather than being given an invented one.
UPDATE "media"
SET "consent_basis" = 'self_upload',
    "updated_at" = now()
WHERE "consent" = true
  AND "consent_basis" IS NULL
  AND "owner_member_id" IS NOT NULL;
