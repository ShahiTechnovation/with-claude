-- ============================================================================
-- 0018 — Events: the Luma corrections, and three events the record missed.
--
-- DATA ONLY. No schema change.
--
-- Source: each event's own luma.com page, read 2026-10-16 (times IST). The
-- same values are in `src/data/events.ts`, and
-- `tests/events-luma-october.test.ts` asserts the two agree after this runs.
--
-- Every UPDATE targets one slug and is guarded on that row's OLD values, so a
-- re-run, or a row someone has since edited, is left alone. A row the
-- organisers adopted into Baserow (`content_authority = 'baserow'`) is skipped:
-- Baserow writes it, and its fix has to be made there.
--
-- Every INSERT is guarded by NOT EXISTS on the slug or the Luma URL, and adds
-- its host rows in the same statement, attached only to the row it created.
--
-- Two checks stop the migration with an error rather than skip in silence: the
-- first statement, before any write, and the last, after them all. Neon's
-- migrator runs each statement on its own, with no transaction, and records
-- the migration only when every statement succeeds. After a stop, fix the
-- rows the error names and run `npm run db:migrate` again: every write here is
-- guarded, so the re-run changes only what is still missing.
-- ============================================================================

-- STOP if another event already holds a Luma link this migration sets, in any
-- form: lu.ma or luma.com, www., a trailing slash, a query or a fragment.
-- That is usually a row the Luma sync promoted. The INSERTs below would skip
-- their event without a word when the link matches exactly, or add a second
-- event when it is spelt another way, and the Indore UPDATE would give a
-- second row the same link. Merge or delete that row by hand first.
DO $$
DECLARE
  "holders" text;
BEGIN
  SELECT string_agg("slug" || ' (' || "registration_url" || ')', ', ' ORDER BY "slug")
  INTO "holders"
  FROM "events"
  WHERE "registration_url" ~* '^https?://(www\.)?(lu\.ma|luma\.com)/(claude-lulm|claude-pmjo|claude-3brg|claude-t91n)/?([?#].*)?$'
    AND "slug" NOT IN (
      'claude-for-everyone-bhopal', 'claude-community-workshop', 'claude-code-workshop-october',
      'claude-meetup-indore'
    );
  IF "holders" IS NOT NULL THEN
    RAISE EXCEPTION '0018 stopped before any change: % already hold a Luma link this migration sets. Merge or delete them by hand, then run the migrations again.', "holders";
  END IF;
END $$;
--> statement-breakpoint

-- luma.com/hphplrbx: ends 19:00.
UPDATE "events"
SET "end_time" = '19:00', "updated_at" = now()
WHERE "slug" = 'claude-code-for-builders'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-18gk: ends 19:00.
UPDATE "events"
SET "end_time" = '19:00', "updated_at" = now()
WHERE "slug" = 'claude-meetup'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-w1nu: ends 20:00.
UPDATE "events"
SET "end_time" = '20:00', "updated_at" = now()
WHERE "slug" = 'claude-community-conversation'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-9g93: ends 20:30.
UPDATE "events"
SET "end_time" = '20:30', "updated_at" = now()
WHERE "slug" = 'getting-started-with-claude'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-7myk: ends 20:30.
UPDATE "events"
SET "end_time" = '20:30', "updated_at" = now()
WHERE "slug" = 'claude-code-workshop'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-jy40: ends 19:30.
UPDATE "events"
SET "end_time" = '19:30', "updated_at" = now()
WHERE "slug" = 'claude-code-workshop-part-two'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-t91n: the Indore meetup's registration link, and its 20:00 end.
UPDATE "events"
SET "registration_url" = 'https://luma.com/claude-t91n', "end_time" = '20:00', "updated_at" = now()
WHERE "slug" = 'claude-meetup-indore'
  AND "registration_url" IS NULL
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-ssrl: ends 20:30.
UPDATE "events"
SET "end_time" = '20:30', "updated_at" = now()
WHERE "slug" = 'claude-for-businesses'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-af61: ended 18:00, not 19:00.
UPDATE "events"
SET "end_time" = '18:00', "updated_at" = now()
WHERE "slug" = 'claude-code-impact-lab'
  AND "end_time" = '19:00'
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-j2dr: 13:10–16:20, as its description says (the page's
-- structured time, 02:30–05:40, disagrees with it).
UPDATE "events"
SET "start_time" = '13:10', "end_time" = '16:20', "updated_at" = now()
WHERE "slug" = 'claude-for-college-builders'
  AND "start_time" = '16:00'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-hj87: Luma's area is Kothri Kalan. The venue name stays.
UPDATE "events"
SET "venue_address" = 'Kothri Kalan', "updated_at" = now()
WHERE "slug" = 'claude-code-workshop-september'
  AND "venue_address" = 'Chiklod Road, Bhopal'
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-44tv: ends 15:00; Luma's area is Noida. The venue name stays.
UPDATE "events"
SET "end_time" = '15:00', "venue_address" = 'Noida', "updated_at" = now()
WHERE "slug" = 'claude-meetup-delhi'
  AND "end_time" IS NULL
  AND "venue_address" = 'Delhi'
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-6khk: started 17:00, not 18:00.
UPDATE "events"
SET "start_time" = '17:00', "updated_at" = now()
WHERE "slug" = 'claude-conversation-september'
  AND "start_time" = '18:00'
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-z01j: ends 18:30.
UPDATE "events"
SET "end_time" = '18:30', "updated_at" = now()
WHERE "slug" = 'claude-code-build-day-fable'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-8le5: ends 17:00.
UPDATE "events"
SET "end_time" = '17:00', "updated_at" = now()
WHERE "slug" = 'agent-and-learn-workshop'
  AND "end_time" IS NULL
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- luma.com/claude-ozni is one two-day programme. This row becomes Day 2, the
-- Impact Lab on 11 October, 09:00–19:30, under Luma's heading without the co-host name. Day 1 (the
-- 10 October workshop, luma.com/claude-pmjo) is inserted below. This row
-- keeps its UUID and slug; Day 1 gets its own.
UPDATE "events"
SET "title" = 'Claude Impact Lab',
    "date" = '2026-10-11',
    "start_time" = '09:00',
    "end_time" = '19:30',
    "updated_at" = now()
WHERE "slug" = 'claude-code-impact-lab-october'
  AND "title" = 'Claude Code Impact Lab'
  AND "date" = '2026-10-10'
  AND "start_time" = '09:00'
  AND "end_time" = '18:00'
  AND "content_authority" <> 'baserow';
--> statement-breakpoint
-- NEW: luma.com/claude-lulm, 6 October 17:30–19:30, venue shared with
-- registrants only. Hosted by Aniket Sahu.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-for-everyone-bhopal', 'Claude for Everyone', 'meetup', c."id", a."id",
    '2026-10-06', '17:30', '19:30', 'Bhopal', true,
    'A community meetup for anyone curious about Claude, AI and how these technologies are shaping the way we learn, work and create.',
    'https://luma.com/claude-lulm', true, 'published', '2026-10-06T17:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (
      SELECT 1 FROM "events"
      WHERE "slug" = 'claude-for-everyone-bhopal' OR "registration_url" = 'https://luma.com/claude-lulm'
    )
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- NEW: luma.com/claude-pmjo, 10 October 16:00–19:00, Day 1 of the
-- programme, venue shared with registrants only. Luma lists Aniket Sahu,
-- Builder Base and Vishal Kumar as hosts.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_private", "summary", "registration_url", "free", "status",
    "created_at", "updated_at"
  )
  SELECT 'claude-community-workshop', 'Claude Community Workshop', 'workshop',
    c."id", a."id", '2026-10-10', '16:00', '19:00', 'Bhopal', true,
    'Hands-on integration workshop, expert session and Impact Lab orientation.',
    'https://luma.com/claude-pmjo', true, 'published', '2026-10-10T16:00:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (
      SELECT 1 FROM "events"
      WHERE "slug" = 'claude-community-workshop' OR "registration_url" = 'https://luma.com/claude-pmjo'
    )
    -- Only once the UPDATE above has made the old row Day 2, or the two would
    -- overlap on 10 October. The closing check reports it if not.
    AND EXISTS (
      SELECT 1 FROM "events"
      WHERE "slug" = 'claude-code-impact-lab-october' AND "date" = '2026-10-11'
    )
  RETURNING "id", "ambassador_id"
),
"primary_host" AS (
  INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
  SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event"
),
"co_host" AS (
  INSERT INTO "event_co_hosts" ("event_id", "builder_id")
  SELECT e."id", b."id" FROM "new_event" e JOIN "builders" b ON b."slug" = 'vishal-kumar'
)
INSERT INTO "event_organizations" ("event_id", "organization_id")
SELECT e."id", o."id" FROM "new_event" e JOIN "organizations" o ON o."slug" = 'builder-base';
--> statement-breakpoint
-- NEW: luma.com/claude-3brg, 15 October 13:30–16:30, at BIBA, Bhopal (the
-- venue is public on Luma). Hosted by Aniket Sahu.
WITH "new_event" AS (
  INSERT INTO "events" (
    "slug", "title", "format", "city_id", "ambassador_id", "date", "start_time", "end_time",
    "venue_name", "venue_address", "venue_private", "summary", "registration_url", "free",
    "status", "created_at", "updated_at"
  )
  SELECT 'claude-code-workshop-october', 'Claude Code Workshop', 'workshop', c."id", a."id",
    '2026-10-15', '13:30', '16:30', 'BIBA', 'Bhopal', false,
    'A hands-on workshop introducing the Claude ecosystem and how developers can build with Claude Code.',
    'https://luma.com/claude-3brg', true, 'published', '2026-10-15T13:30:00+05:30', now()
  FROM "cities" c, "ambassadors" a
  WHERE c."slug" = 'bhopal'
    AND a."slug" = 'aniket-sahu'
    AND NOT EXISTS (
      SELECT 1 FROM "events"
      WHERE "slug" = 'claude-code-workshop-october' OR "registration_url" = 'https://luma.com/claude-3brg'
    )
  RETURNING "id", "ambassador_id"
)
INSERT INTO "event_hosts" ("event_id", "ambassador_id", "role", "source", "confidence")
SELECT "id", "ambassador_id", 'primary_host', 'curated', 1.00 FROM "new_event";
--> statement-breakpoint
-- STOP unless the three new events are here, each with Aniket Sahu as primary
-- host, and the 10 October workshop has its co-host and organisation. An INSERT
-- above writes nothing when its city or ambassador is missing, when another
-- row holds its slug, or (Day 1) when the Day 2 UPDATE was skipped; a missing
-- builder or organisation writes the event without its co-host or
-- organisation row. Either way a re-run would never fill the gap. An empty
-- database is left alone: a new one gets these rows from `npm run db:import`.
DO $$
DECLARE
  "gaps" text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "events") THEN
    RETURN;
  END IF;
  SELECT string_agg("gap", '; ' ORDER BY "gap") INTO "gaps" FROM (
    SELECT n."slug" || ' is missing or has no primary host aniket-sahu' AS "gap"
    FROM (
      VALUES ('claude-for-everyone-bhopal'), ('claude-community-workshop'),
        ('claude-code-workshop-october')
    ) AS n("slug")
    WHERE NOT EXISTS (
      SELECT 1 FROM "events" e
      JOIN "event_hosts" h ON h."event_id" = e."id" AND h."role" = 'primary_host'
      JOIN "ambassadors" a ON a."id" = h."ambassador_id"
      WHERE e."slug" = n."slug" AND a."slug" = 'aniket-sahu'
    )
    UNION ALL
    SELECT 'claude-community-workshop has no co-host vishal-kumar'
    WHERE NOT EXISTS (
      SELECT 1 FROM "events" e
      JOIN "event_co_hosts" c ON c."event_id" = e."id"
      JOIN "builders" b ON b."id" = c."builder_id"
      WHERE e."slug" = 'claude-community-workshop' AND b."slug" = 'vishal-kumar'
    )
    UNION ALL
    SELECT 'claude-community-workshop has no organisation builder-base'
    WHERE NOT EXISTS (
      SELECT 1 FROM "events" e
      JOIN "event_organizations" eo ON eo."event_id" = e."id"
      JOIN "organizations" o ON o."id" = eo."organization_id"
      WHERE e."slug" = 'claude-community-workshop' AND o."slug" = 'builder-base'
    )
  ) AS "p";
  IF "gaps" IS NOT NULL THEN
    RAISE EXCEPTION '0018 stopped after its changes, incomplete: %. Fix those rows by hand, then run the migrations again.', "gaps";
  END IF;
END $$;
