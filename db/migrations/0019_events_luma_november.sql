-- ============================================================================
-- 0019 — Events: nine Luma events the record missed, as curated rows.
--
-- DATA ONLY. No schema change.
--
-- Source: each event's own luma.com page, read 2026-11-12 (times IST). The
-- same values are in `src/data/events.ts`, and
-- `tests/events-luma-november.test.ts` asserts the two agree after this runs.
--
-- Four are upcoming and have no venue on Luma yet, so they show the city only
-- (venue shared with registrants). Five are over; Luma has dropped them from
-- its feed, and three of them moved after the sync last saw them. Each is
-- hosted by Aniket Sahu.
--
-- The sync may already hold some of these events as its own rows (a
-- `source_id`), published with no host credit or withdrawn. Those are archived
-- with `canceled_at` left NULL: an editor's takedown, which the sync never
-- revives. They keep their slug and their source link. Their staging rows in
-- `event_source_records` are left as they are.
--
-- Every INSERT is guarded by NOT EXISTS on the slug, and adds its host row in
-- the same statement, attached only to the row it created.
--
-- Two checks stop the migration with an error rather than skip in silence: the
-- first statement, before any write, and the last, after them all. Neon's
-- migrator runs each statement on its own, with no transaction, and records
-- the migration only when every statement succeeds. After a stop, fix the
-- rows the error names and run `npm run db:migrate` again: every write here is
-- guarded, so the re-run changes only what is still missing.
-- ============================================================================

-- STOP if one of these events' Luma links (in any form: lu.ma or luma.com,
-- www., a trailing slash, a query or a fragment) or Luma ids is already held
-- by a curated row under another slug, or by a row the organisers adopted into
-- Baserow. The INSERTs below would add a second copy of the event, and the
-- archive below must not touch a Baserow row. Merge or delete it by hand first.
DO $$
DECLARE
  "holders" text;
BEGIN
  SELECT string_agg("slug" || ' (' || coalesce("registration_url", "external_id") || ')', ', ' ORDER BY "slug")
  INTO "holders"
  FROM "events"
  WHERE (
      "registration_url" ~* '^https?://(www\.)?(lu\.ma|luma\.com)/(claude-qax4|claude-s0yt|claude-8ej2|claude-0yz1|claude-4nyy|claude-vtm6|claude-a33d|claude-b4mc|claude-89py)/?([?#].*)?$'
      OR "external_id" IN (
        'evt-4CHDcOU7oEqR3gK', 'evt-Vpm9XpMA9kiNnax', 'evt-2nvTaWT6ZK53QzK', 'evt-lEdV5rOtFA9Zysr',
        'evt-A313V0jzFkmmvub', 'evt-K8HvFYekuXrG6DW', 'evt-ste1FXlgIXRMxj4', 'evt-8CVlKGOGLHQNv1T',
        'evt-UzYqBM21ToPFjmx'
      )
    )
    AND (
      ("source_id" IS NULL AND "slug" NOT IN (
        'claude-code-meetup-23-october', 'claude-for-founders-meetup-25-october',
        'claude-code-workshop-1-november', 'claude-code-meetup-workshop-3-november',
        'claude-code-workshop-7-november', 'claude-code-workshop-14-november',
        'claude-meetup-18-november', 'claude-code-workshop-19-november',
        'claude-build-day-22-november'
      ))
      OR "content_authority" = 'baserow'
    );
  IF "holders" IS NOT NULL THEN
    RAISE EXCEPTION '0019 stopped before any change: % already hold a Luma link or id this migration sets. Merge or delete them by hand, then run the migrations again.', "holders";
  END IF;
END $$;
--> statement-breakpoint

-- The sync's own rows for these events: archived as an editor's takedown.
UPDATE "events"
SET "status" = 'archived', "canceled_at" = NULL, "updated_at" = now()
WHERE "source_id" IS NOT NULL
  AND "content_authority" <> 'baserow'
  AND (
    "registration_url" ~* '^https?://(www\.)?(lu\.ma|luma\.com)/(claude-qax4|claude-s0yt|claude-8ej2|claude-0yz1|claude-4nyy|claude-vtm6|claude-a33d|claude-b4mc|claude-89py)/?([?#].*)?$'
    OR "external_id" IN (
      'evt-4CHDcOU7oEqR3gK', 'evt-Vpm9XpMA9kiNnax', 'evt-2nvTaWT6ZK53QzK', 'evt-lEdV5rOtFA9Zysr',
      'evt-A313V0jzFkmmvub', 'evt-K8HvFYekuXrG6DW', 'evt-ste1FXlgIXRMxj4', 'evt-8CVlKGOGLHQNv1T',
      'evt-UzYqBM21ToPFjmx'
    )
  )
  AND ("status" <> 'archived' OR "canceled_at" IS NOT NULL);
--> statement-breakpoint

-- NEW: luma.com/claude-qax4, 23 October 17:30–20:30, at The Public House
-- Restaurant, Bhopal.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_address", "venue_private", "summary", "registration_url", "free",
    "status", "created_at", "updated_at"
  )
  SELECT 'claude-code-meetup-23-october', 'Claude Code Meetup', 'meetup', c."id", a."id",
    '2026-10-23', '17:30', '20:30', 'The Public House Restaurant', 'Bhopal', false,
    'Claude Code Meetup, an evening for developers, AI engineers and builders in Bhopal who are using Claude to ship real things.',
    'https://luma.com/claude-qax4', true, 'published', '2026-10-23T17:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-code-meetup-23-october')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-s0yt, 25 October 17:30–20:00, at Hotel Varshish Inn,
-- Bhopal.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_address", "venue_private", "summary", "registration_url", "free",
    "status", "created_at", "updated_at"
  )
  SELECT 'claude-for-founders-meetup-25-october', 'Claude for Founders Meetup', 'meetup',
    c."id", a."id", '2026-10-25', '17:30', '20:00', 'Hotel Varshish Inn', 'Bhopal', false,
    'Real stories from founders and builders using Claude in their day-to-day work, from product and code to marketing, ops and fundraising.',
    'https://luma.com/claude-s0yt', true, 'published', '2026-10-25T17:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-for-founders-meetup-25-october')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-8ej2, announced for 31 October and held on 1 November
-- 16:00–19:00, at BIBA, Bhopal.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "rescheduled_from",
    "start_time", "end_time", "venue_name", "venue_address", "venue_private", "summary",
    "registration_url", "free", "status", "created_at", "updated_at"
  )
  SELECT 'claude-code-workshop-1-november', 'Claude Code Workshop', 'workshop', c."id", a."id",
    '2026-11-01', '2026-10-31', '16:00', '19:00', 'BIBA', 'Bhopal', false,
    'A hands-on Claude Code Workshop in Bhopal, a session for developers, students and builders who want to go from “I’ve heard of Claude Code” to “I just shipped something with it.”',
    'https://luma.com/claude-8ej2', true, 'published', '2026-11-01T16:00:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-code-workshop-1-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-0yz1, 3 November 15:30–18:30, at BKC DIVE, Mumbai.
-- Credited to Aniket Sahu alone (the user's decision, 12 November).
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_address", "venue_private", "summary", "registration_url", "free",
    "status", "created_at", "updated_at"
  )
  SELECT 'claude-code-meetup-workshop-3-november', 'Claude Code Meetup & Workshop', 'workshop',
    c."id", a."id", '2026-11-03', '15:30', '18:30', 'BKC DIVE', 'Mumbai', false,
    'A special Claude Community Meetup in Mumbai during Devcon week, when the Ethereum ecosystem’s annual flagship conference brings developers, founders and builders from around the world to the city.',
    'https://luma.com/claude-0yz1', true, 'published', '2026-11-03T15:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'mumbai'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-code-meetup-workshop-3-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-4nyy, 7 November 18:00–20:30, Bhopal. Its venue is not
-- known, so the city only.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-code-workshop-7-november', 'Claude Code Workshop', 'workshop', c."id", a."id",
    '2026-11-07', '18:00', '20:30', 'Bhopal', true,
    'For builders who’ve moved past “hello world” and want to use Claude Code the way experienced developers do: on real projects, with real workflows, at real speed.',
    'https://luma.com/claude-4nyy', true, 'published', '2026-11-07T18:00:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-code-workshop-7-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-vtm6, 14 November 17:30–20:00, Bhopal, venue shared
-- with registrants only.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-code-workshop-14-november', 'Claude Code Workshop', 'workshop', c."id", a."id",
    '2026-11-14', '17:30', '20:00', 'Bhopal', true,
    'Ship It, a hands-on Claude Code workshop by Claude Community Bhopal for developers, students and makers who are tired of half-finished projects.',
    'https://luma.com/claude-vtm6', true, 'published', '2026-11-14T17:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-code-workshop-14-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-a33d, 18 November 17:30–20:00, Bhopal, venue shared
-- with registrants only.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-meetup-18-november', 'Claude Meetup', 'meetup', c."id", a."id",
    '2026-11-18', '17:30', '20:00', 'Bhopal', true,
    'Claude at Work, a midweek meetup by Claude Community Bhopal about the everyday side of Claude: how students, developers, founders, marketers, teachers and professionals in our city use it to write, research, plan, analyze and get real work done.',
    'https://luma.com/claude-a33d', true, 'published', '2026-11-18T17:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-meetup-18-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-b4mc, 19 November 13:00–16:00, Bhopal, venue shared
-- with registrants only.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-code-workshop-19-november', 'Claude Code Workshop', 'workshop', c."id", a."id",
    '2026-11-19', '13:00', '16:00', 'Bhopal', true,
    'Claude Code for Student Builders, an afternoon workshop by Claude Community Bhopal for college students who want to learn the AI coding skills the industry is starting to expect.',
    'https://luma.com/claude-b4mc', true, 'published', '2026-11-19T13:00:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-code-workshop-19-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-89py, 22 November 17:30–20:00, Bhopal, venue shared
-- with registrants only.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-build-day-22-november', 'Claude Build Day', 'hackathon', c."id", a."id",
    '2026-11-22', '17:30', '20:00', 'Bhopal', true,
    'The Claude Build Day, a hands-on evening by Claude Community Bhopal for developers, builders, students and AI enthusiasts.',
    'https://luma.com/claude-89py', true, 'published', '2026-11-22T17:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (SELECT 1 FROM "events" WHERE "slug" = 'claude-build-day-22-november')
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- STOP unless each of the nine is a published curated row with its own Luma
-- link and Aniket Sahu as primary host, and no other live row holds one of
-- their links. An INSERT above writes nothing when its city or ambassador is
-- missing or another row holds its slug, and a re-run would never fill that
-- gap. An empty database is left alone: a new one gets these rows from
-- `npm run db:import`.
DO $$
DECLARE
  "gaps" text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "events") THEN
    RETURN;
  END IF;
  SELECT string_agg("gap", '; ' ORDER BY "gap") INTO "gaps" FROM (
    SELECT n."slug" || ' is missing, or is not a published curated row with ' || n."url" || ' and primary host aniket-sahu' AS "gap"
    FROM (
      VALUES ('claude-code-meetup-23-october', 'https://luma.com/claude-qax4'),
        ('claude-for-founders-meetup-25-october', 'https://luma.com/claude-s0yt'),
        ('claude-code-workshop-1-november', 'https://luma.com/claude-8ej2'),
        ('claude-code-meetup-workshop-3-november', 'https://luma.com/claude-0yz1'),
        ('claude-code-workshop-7-november', 'https://luma.com/claude-4nyy'),
        ('claude-code-workshop-14-november', 'https://luma.com/claude-vtm6'),
        ('claude-meetup-18-november', 'https://luma.com/claude-a33d'),
        ('claude-code-workshop-19-november', 'https://luma.com/claude-b4mc'),
        ('claude-build-day-22-november', 'https://luma.com/claude-89py')
    ) AS n("slug", "url")
    WHERE NOT EXISTS (
      SELECT 1 FROM "events" e
      JOIN "event_hosts" h ON h."event_id" = e."id" AND h."role" = 'primary_host'
      JOIN "ambassadors" a ON a."id" = h."ambassador_id"
      WHERE e."slug" = n."slug"
        AND e."source_id" IS NULL
        AND e."status" = 'published'
        AND e."registration_url" = n."url"
        AND a."slug" = 'aniket-sahu'
    )
    UNION ALL
    SELECT "slug" || ' (' || "registration_url" || ') holds one of their links and is not archived'
    FROM "events"
    WHERE "registration_url" ~* '^https?://(www\.)?(lu\.ma|luma\.com)/(claude-qax4|claude-s0yt|claude-8ej2|claude-0yz1|claude-4nyy|claude-vtm6|claude-a33d|claude-b4mc|claude-89py)/?([?#].*)?$'
      AND "status" <> 'archived'
      AND "slug" NOT IN (
        'claude-code-meetup-23-october', 'claude-for-founders-meetup-25-october',
        'claude-code-workshop-1-november', 'claude-code-meetup-workshop-3-november',
        'claude-code-workshop-7-november', 'claude-code-workshop-14-november',
        'claude-meetup-18-november', 'claude-code-workshop-19-november',
        'claude-build-day-22-november'
      )
  ) AS "p";
  IF "gaps" IS NOT NULL THEN
    RAISE EXCEPTION '0019 stopped after its changes, incomplete: %. Fix those rows by hand, then run the migrations again.', "gaps";
  END IF;
END $$;
