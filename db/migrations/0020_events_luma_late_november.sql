-- ============================================================================
-- 0020 — Events: three new Bhopal events, and two Luma corrections.
--
-- DATA ONLY. No schema change.
--
-- Source: Luma's public data for each event, read 2026-11-22 (times IST). The
-- same values are in `src/data/events.ts`, and
-- `tests/events-luma-late-november.test.ts` asserts the two agree after this
-- runs. 0019 is left as it is: this migration takes its rows from 0019's
-- values to Luma's current ones.
--
-- The two UPDATEs target one slug each and are guarded on every value they
-- change still being 0019's, so a re-run, or a row someone has since edited,
-- is left alone. The INSERTs follow 0019: NOT EXISTS on the slug, and the host
-- row in the same statement. The sync's own rows for the new events are
-- archived with `canceled_at` left NULL, an editor's takedown the sync never
-- revives.
--
-- Two checks stop the migration with an error rather than skip in silence: the
-- first statement, before any write, and the last, after them all. Neon's
-- migrator runs each statement on its own, with no transaction, and records
-- the migration only when every statement succeeds. After a stop, fix the
-- rows the error names and run `npm run db:migrate` again: every write here is
-- guarded, so the re-run changes only what is still missing.
-- ============================================================================

-- STOP if one of the new events' Luma links (in any form: lu.ma or luma.com,
-- www., a trailing slash, a query or a fragment) or Luma ids is already held
-- by a curated row under another slug, or by a Baserow row; or if one of the
-- two rows corrected below is a Baserow row or the sync's own row. Merge or
-- delete it by hand first.
DO $$
DECLARE
  "holders" text;
BEGIN
  SELECT string_agg("holder", '; ' ORDER BY "holder") INTO "holders" FROM (
    SELECT "slug" || ' (' || coalesce("registration_url", "external_id") || ') already holds a Luma link or id this migration sets' AS "holder"
    FROM "events"
    WHERE (
        "registration_url" ~* '^https?://(www\.)?(lu\.ma|luma\.com)/(claude-r38s|claude-4xxl|claude-m3ex)/?([?#].*)?$'
        OR "external_id" IN ('evt-7668zjjRwZFuijG', 'evt-S7CYCOUCLbCohb8', 'evt-N1btN1vJnOVOEc8')
      )
      AND (
        ("source_id" IS NULL AND "slug" NOT IN (
          'claude-for-working-professionals-26-november',
        'claude-code-workshop-for-government-officials-29-november',
        'claude-for-chartered-accountants-meetup-6-december'
        ))
        OR "content_authority" = 'baserow'
      )
    UNION ALL
    SELECT "slug" || ' is a Baserow or feed row, which this migration must not correct'
    FROM "events"
    WHERE "slug" IN ('claude-meetup-18-november', 'claude-build-day-22-november')
      AND ("content_authority" = 'baserow' OR "source_id" IS NOT NULL)
  ) AS "h";
  IF "holders" IS NOT NULL THEN
    RAISE EXCEPTION '0020 stopped before any change: %. Merge or delete them by hand, then run the migrations again.', "holders";
  END IF;
END $$;
--> statement-breakpoint

-- The sync's own rows for the new events: archived as an editor's takedown.
UPDATE "events"
SET "status" = 'archived', "canceled_at" = NULL, "updated_at" = now()
WHERE "source_id" IS NOT NULL
  AND "content_authority" <> 'baserow'
  AND (
    "registration_url" ~* '^https?://(www\.)?(lu\.ma|luma\.com)/(claude-r38s|claude-4xxl|claude-m3ex)/?([?#].*)?$'
    OR "external_id" IN ('evt-7668zjjRwZFuijG', 'evt-S7CYCOUCLbCohb8', 'evt-N1btN1vJnOVOEc8')
  )
  AND ("status" <> 'archived' OR "canceled_at" IS NOT NULL);
--> statement-breakpoint

-- luma.com/claude-a33d, 18 November: Luma's new title, its 19:30 end, the
-- venue it now shows, and the co-host its About names.
UPDATE "events"
SET "title" = 'Claude Community x Agrati Tech Meetup',
    "end_time" = '19:30',
    "venue_name" = 'Poppin’ Deli',
    "venue_address" = 'Bhopal',
    "venue_private" = false,
    "summary" = 'Claude at Work, a midweek meetup by Claude Community Bhopal, co-hosted with Agrati Tech Labs, about the everyday side of Claude: how students, developers, founders, marketers, teachers and professionals in our city use it to write, research, plan, analyze and get real work done.',
    "updated_at" = now()
WHERE "slug" = 'claude-meetup-18-november'
  AND "source_id" IS NULL
  AND "content_authority" <> 'baserow'
  AND "title" = 'Claude Meetup'
  AND "end_time" = '20:00'
  AND "venue_name" = 'Bhopal'
  AND "venue_address" IS NULL
  AND "venue_private"
  AND "summary" = 'Claude at Work, a midweek meetup by Claude Community Bhopal about the everyday side of Claude: how students, developers, founders, marketers, teachers and professionals in our city use it to write, research, plan, analyze and get real work done.';
--> statement-breakpoint

-- Agrati Tech Labs, the 18 November co-host, under the slug the import gives
-- it. Only when that event is here: an empty database gets it from
-- `npm run db:import`.
INSERT INTO "organizations" ("slug", "name")
SELECT 'agrati-tech-labs', 'Agrati Tech Labs'
WHERE EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-meetup-18-november')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "event_organizations" ("event_id", "organization_id")
SELECT e."id", o."id"
FROM "events" e
JOIN "organizations" o ON o."slug" = 'agrati-tech-labs'
WHERE e."slug" = 'claude-meetup-18-november'
  AND e."source_id" IS NULL
  AND e."content_authority" <> 'baserow'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- luma.com/claude-89py, 22 November: Luma's new title, and 14:00–19:00. The
-- venue stays shared with registrants only.
UPDATE "events"
SET "title" = 'Claude Code Build Day - Fable 5.2',
    "start_time" = '14:00',
    "end_time" = '19:00',
    "updated_at" = now()
WHERE "slug" = 'claude-build-day-22-november'
  AND "source_id" IS NULL
  AND "content_authority" <> 'baserow'
  AND "title" = 'Claude Build Day'
  AND "start_time" = '17:30'
  AND "end_time" = '20:00';
--> statement-breakpoint

-- NEW: luma.com/claude-r38s, 26 November 17:00–20:00, at Starbucks, DB Mall,
-- Bhopal (named in Luma's public About).
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_address", "venue_private", "summary", "registration_url", "free",
    "status", "created_at", "updated_at"
  )
  SELECT 'claude-for-working-professionals-26-november', 'Claude for Working Professionals',
    'meetup', c."id", a."id", '2026-11-26', '17:00', '20:00', 'Starbucks, DB Mall', 'Bhopal',
    false,
    'A small curated Claude Community Bhopal meetup over coffee, for working professionals who are curious about AI and want to see how Claude can make a real difference in their day-to-day work.',
    'https://luma.com/claude-r38s', true, 'published', '2026-11-26T17:00:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-for-working-professionals-26-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-4xxl, 29 November 17:00–19:30, Bhopal, venue shared
-- with registrants only.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-code-workshop-for-government-officials-29-november',
    'Claude Code Workshop for Government Officials', 'workshop', c."id", a."id", '2026-11-29',
    '17:00', '19:30', 'Bhopal', true,
    'Claude for Government, a hands-on Claude Code workshop and meetup for government officials and public-sector tech teams in Bhopal and Madhya Pradesh.',
    'https://luma.com/claude-4xxl', true, 'published', '2026-11-29T17:00:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-code-workshop-for-government-officials-29-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-m3ex, 6 December 17:30–19:30, Bhopal, venue shared
-- with registrants only.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-for-chartered-accountants-meetup-6-december',
    'Claude for Chartered Accountants Meetup', 'meetup', c."id", a."id", '2026-12-06', '17:30',
    '19:30', 'Bhopal', true,
    'Claude for Chartered Accountants, a meetup for Chartered Accountants, CA students, auditors, tax consultants and finance professionals in Bhopal.',
    'https://luma.com/claude-m3ex', true, 'published', '2026-12-06T17:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-for-chartered-accountants-meetup-6-december')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- STOP unless each of the five is a published curated row with its own Luma
-- link, Aniket Sahu as primary host and the values above; the 18 November
-- meetup has Agrati Tech Labs; and no other live row holds a new event's
-- link. A skipped UPDATE or INSERT would never be filled by a re-run. An empty
-- database is left alone: a new one gets these rows from `npm run db:import`.
DO $$
DECLARE
  "gaps" text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "events") THEN
    RETURN;
  END IF;
  SELECT string_agg("gap", '; ' ORDER BY "gap") INTO "gaps" FROM (
    SELECT n."slug" || ' is missing, or is not a published curated row with ' || n."url" || ', primary host aniket-sahu and this migration''s values' AS "gap"
    FROM (
      VALUES
        ('claude-meetup-18-november', 'https://luma.com/claude-a33d',
          'Claude Community x Agrati Tech Meetup', '2026-11-18'::date, '17:30'::time, '19:30'::time,
          'Poppin’ Deli', 'Bhopal', false,
          'Claude at Work, a midweek meetup by Claude Community Bhopal, co-hosted with Agrati Tech Labs, about the everyday side of Claude: how students, developers, founders, marketers, teachers and professionals in our city use it to write, research, plan, analyze and get real work done.'),
        ('claude-build-day-22-november', 'https://luma.com/claude-89py',
          'Claude Code Build Day - Fable 5.2', '2026-11-22', '14:00', '19:00', 'Bhopal', NULL, true,
          'The Claude Build Day, a hands-on evening by Claude Community Bhopal for developers, builders, students and AI enthusiasts.'),
        ('claude-for-working-professionals-26-november', 'https://luma.com/claude-r38s',
          'Claude for Working Professionals', '2026-11-26', '17:00', '20:00', 'Starbucks, DB Mall',
          'Bhopal', false,
          'A small curated Claude Community Bhopal meetup over coffee, for working professionals who are curious about AI and want to see how Claude can make a real difference in their day-to-day work.'),
        ('claude-code-workshop-for-government-officials-29-november', 'https://luma.com/claude-4xxl',
          'Claude Code Workshop for Government Officials', '2026-11-29', '17:00', '19:30', 'Bhopal',
          NULL, true,
          'Claude for Government, a hands-on Claude Code workshop and meetup for government officials and public-sector tech teams in Bhopal and Madhya Pradesh.'),
        ('claude-for-chartered-accountants-meetup-6-december', 'https://luma.com/claude-m3ex',
          'Claude for Chartered Accountants Meetup', '2026-12-06', '17:30', '19:30', 'Bhopal', NULL,
          true,
          'Claude for Chartered Accountants, a meetup for Chartered Accountants, CA students, auditors, tax consultants and finance professionals in Bhopal.')
    ) AS n("slug", "url", "title", "date", "start_time", "end_time", "venue_name", "venue_address", "venue_private", "summary")
    WHERE NOT EXISTS (
      SELECT 1 FROM "events" e
      JOIN "event_hosts" h ON h."event_id" = e."id" AND h."role" = 'primary_host'
      JOIN "ambassadors" a ON a."id" = h."ambassador_id"
      WHERE e."slug" = n."slug"
        AND e."source_id" IS NULL
        AND e."content_authority" <> 'baserow'
        AND e."status" = 'published'
        AND e."registration_url" = n."url"
        AND e."title" = n."title"
        AND e."date" = n."date"
        AND e."start_time" = n."start_time"
        AND e."end_time" = n."end_time"
        AND e."venue_name" = n."venue_name"
        AND e."venue_address" IS NOT DISTINCT FROM n."venue_address"
        AND e."venue_private" = n."venue_private"
        AND e."summary" = n."summary"
        AND a."slug" = 'aniket-sahu'
    )
    UNION ALL
    SELECT 'claude-meetup-18-november has no organisation agrati-tech-labs'
    WHERE NOT EXISTS (
      SELECT 1 FROM "events" e
      JOIN "event_organizations" eo ON eo."event_id" = e."id"
      JOIN "organizations" o ON o."id" = eo."organization_id"
      WHERE e."slug" = 'claude-meetup-18-november' AND o."slug" = 'agrati-tech-labs'
    )
    UNION ALL
    SELECT "slug" || ' (' || "registration_url" || ') holds one of their links and is not archived'
    FROM "events"
    WHERE "registration_url" ~* '^https?://(www\.)?(lu\.ma|luma\.com)/(claude-r38s|claude-4xxl|claude-m3ex)/?([?#].*)?$'
      AND "status" <> 'archived'
      AND "slug" NOT IN (
        'claude-for-working-professionals-26-november',
        'claude-code-workshop-for-government-officials-29-november',
        'claude-for-chartered-accountants-meetup-6-december'
      )
  ) AS "p";
  IF "gaps" IS NOT NULL THEN
    RAISE EXCEPTION '0020 stopped after its changes, incomplete: %. Fix those rows by hand, then run the migrations again.', "gaps";
  END IF;
END $$;
