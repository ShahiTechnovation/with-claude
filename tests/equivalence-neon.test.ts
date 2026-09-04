/**
 * TS vs REAL NEON EQUIVALENCE.
 *
 * The sibling of `tests/equivalence.test.ts`, which runs the identical
 * comparison against PGlite for speed and hermeticity in ordinary CI. This
 * file runs the SAME comparison against the actual Neon instance the public
 * build will read from in production, connected over the real network, using
 * whatever `DATABASE_URL` the environment provides.
 *
 * It is NOT part of `npm test` — see the guard below — because it requires a
 * live credential and a network round trip per query, and because a CI run
 * with no `DATABASE_URL` must not silently skip a check it claims to run. It
 * is invoked deliberately, by name, when a real Neon verification is wanted:
 *
 *     npx vitest run tests/equivalence-neon.test.ts
 *
 * ── HOW THIS IS SET UP ───────────────────────────────────────────────────
 *
 * The record already imported into Neon by `npm run db:import` (Step 3) is
 * read as-is — this file does NOT re-run the importer, so what is compared is
 * exactly the database a real build would connect to, not a freshly seeded
 * copy of it:
 *
 *     Neon (already imported) ──loadRecordSet──▶ RecordSet
 *     src/data/*.ts           ──tsRecordSet────▶ RecordSet
 *                                                    │
 *                                        deep-compare both
 *
 * ── WHY THE SELECTORS ARE COMPARED TOO, AND HOW ──────────────────────────
 *
 * Equal record sets already imply equal selectors, because the selectors are
 * one piece of shared code reading whichever set it was handed — that is the
 * entire point of putting the seam at `RecordSet` (see `src/data/source.ts`).
 *
 * They are still compared, for two reasons. It proves the seam actually is
 * where the architecture says it is: if a selector had quietly grown its own
 * source-dependent branch, record-set equality would not catch it. And it
 * gives a failure that names the surface a visitor would notice — "timeline
 * differs" is a more useful thing to be told than
 * "events[7].agenda[2].detail differs", even when they are the same bug.
 *
 * `__setRecords` swaps the dataset under the selector layer so both passes run
 * the same module. It exists for this file and nothing else.
 */
import 'dotenv/config';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle, type NeonHttpDatabase } from 'drizzle-orm/neon-http';
import * as schema from '../db/schema';
import { databaseUrl, isProduction } from '../db/env';
import { isNeonUrl } from '../db/pool';
import { loadRecordSet, NON_PUBLIC_CONTENT_STATUSES } from '../src/data/source-db';
import { tsRecordSet } from '../src/data/source-ts';
import { RECORD_KEYS, dataSourceName, type RecordSet } from '../src/data/source';
import { __setRecords } from '../src/data/dataset';
import * as selectors from '../src/data';
import { buildSearchIndex, searchVocabulary } from '../src/lib/search';
import { isCityIndexable, nonIndexablePaths, indexableCityPaths } from '../src/lib/indexable';

type NeonDb = NeonHttpDatabase<typeof schema>;

/**
 * A FIXED CLOCK.
 *
 * Every event-shaped selector on this site derives its answer from the current
 * time, so comparing two passes taken milliseconds apart could differ for a
 * reason that has nothing to do with the data source — an event that went
 * `today` to `live` between them. The comparison is of sources, so the clock
 * is held still.
 *
 * Deliberately mid-record: some events are behind this date and some ahead of
 * it, so the upcoming/past/next selectors all have something to say.
 */
const NOW = new Date('2026-09-04T12:00:00+05:30');

let db: NeonDb;
let fromDb: RecordSet;
let fromTs: RecordSet;

/**
 * A GUARD, NOT A SKIP.
 *
 * A missing `DATABASE_URL` or a non-Neon connection string fails this suite
 * loudly rather than silently passing zero tests — a green run with nothing
 * actually executed against Neon is worse than a red one, because it would
 * report a verification that never happened.
 */
beforeAll(async () => {
  const url = databaseUrl();

  if (!isNeonUrl(url)) {
    throw new Error(
      'tests/equivalence-neon.test.ts requires DATABASE_URL to point at a real Neon ' +
        'instance (a *.neon.tech or *.neon.build host). It refuses to run against ' +
        'localhost or any other PostgreSQL, because the entire point of this file is to ' +
        'exercise the actual production database rather than a substitute for it. Use ' +
        'tests/equivalence.test.ts (PGlite) for that.',
    );
  }

  db = drizzle(neon(url), { schema });

  // The record already imported by `npm run db:import` — read as-is, not
  // re-seeded, so this compares against exactly what a real build would see.
  fromDb = await loadRecordSet(db as never);
  fromTs = tsRecordSet();

  if (fromDb.cities.length === 0) {
    throw new Error(
      'Neon returned zero public cities. Either the import has not been run against ' +
        'this database, or every city is unpublished. Run `npm run db:import` first.',
    );
  }
}, 60_000);

afterAll(() => {
  // Leave the selector layer reading its real source for any other suite.
  __setRecords(undefined);
  // The neon-http driver is stateless per request — there is no pool to close.
});

/** Evaluate a selector against a given record set, then put things back. */
function against<T>(records: RecordSet, read: () => T): T {
  __setRecords(records);
  try {
    return read();
  } finally {
    __setRecords(undefined);
  }
}

/**
 * WHAT IS NORMALISED BEFORE COMPARING, AND WHY EACH ONE IS SOUND.
 *
 * Every entry here was found by this suite failing, then investigated. None is
 * excluded to make a comparison pass: each is either a field no code on the
 * site can observe, or a field where the database is provably saying the same
 * thing in a different arrangement.
 *
 *   id           DROPPED. Nothing on the site reads an entity's `id` — not one
 *                page, component, selector or helper. The record authors them
 *                by hand (`prj-navdisha`) and the database generates uuids,
 *                and the identity the site uses everywhere is the SLUG, which
 *                is compared in full and is the key every record comparison is
 *                made on. Comparing an unobservable field would only force the
 *                reader to fabricate ids, which would misrepresent where the
 *                record came from.
 *
 *   roles        CANONICALISED, not dropped. `ambassador` is filtered from
 *                both sides before comparing, and everything else is compared
 *                exactly. The value cannot mean anything on a builder: the
 *                status is granted by Anthropic, recorded in `ambassadors`
 *                with its provenance, and rendered from there. Both places
 *                that print role chips already filter it, the search index now
 *                does too, and the database refuses to store it (a CHECK on
 *                `builders.roles`). So the filtered list is what every reader
 *                actually sees, and it is compared in full.
 *
 *   eventSlugs   DROPPED here, and checked by its own assertion below.
 *                `projectSlugs` likewise.
 *
 *                These two are the record's DECLARED lists, and the database
 *                does not merely reorder them — it derives them from the real
 *                credits (co-hosted, spoke, attended) and therefore knows
 *                MORE rooms than the hand-written list declares. Vishal Kumar
 *                declares one workshop and co-hosted three.
 *
 *                A set comparison would fail on that and a set comparison
 *                should fail on it, because the lists are genuinely different.
 *                What matters is that nothing a reader sees changes, and that
 *                is two separate claims, both asserted below rather than
 *                assumed:
 *
 *                  · `eventsOf()` and `projectsOf()` — which union declared
 *                    with credited, and are what every page actually renders —
 *                    are compared per builder, exactly, in full.
 *                  · the database's list is a strict SUPERSET of the
 *                    declaration, so the extra entries are additional true
 *                    credits and never a lost one.
 *
 *                Dropping them from the structural comparison and asserting
 *                both claims directly is stronger than folding them into a
 *                set, which would have hidden a genuinely missing credit.
 *
 *   createdAt    DROPPED ON EVENTS ONLY, and compared exactly everywhere else.
 *
 *                An event's creation date is the one timestamp the record can
 *                always evidence — it existed no later than the day it was
 *                held — and the importer sets it from `date` for that reason.
 *                The record leaves the field unset because it already carries
 *                the same fact in `date`, which is compared in full and is
 *                what every event surface actually reads. Nothing on the site
 *                reads an event's `createdAt`: the feed and the timeline take
 *                `event.date`.
 *
 *                It is NOT dropped on builders, projects, cities, stories, use
 *                cases or guides. There it is a fact one source could hold and
 *                the other not, so it is compared exactly — and the Impact Lab
 *                projects were backfilled into the TypeScript record rather
 *                than excluded here, so both sources carry the same true date.
 *                `gains a date only where the database has evidence for one`
 *                below pins exactly where this applies.
 */
const DROPPED = ['id', 'updatedAt', 'eventSlugs', 'projectSlugs'] as const;

/**
 * `updatedAt` is dropped unconditionally, on every shape — unlike `createdAt`,
 * which is only dropped on events. The record has no notion of "last
 * modified" at all, on anything, and never will; there is nothing to
 * backfill it with the way the Impact Lab `createdAt` was backfilled. See the
 * `records` describe block above for the full argument.

/**
 * True for a shape that is an event record.
 *
 * Identified structurally rather than by a flag, because these objects arrive
 * nested inside `CitySignal`, `PhotoRecordItem` and the rest, with no marker
 * saying what they are. `startTime` and `venue` together are unique to an
 * event in this domain.
 */
function isEventShape(value: Record<string, unknown>): boolean {
  return 'startTime' in value && 'venue' in value && 'format' in value;
}

/**
 * Apply the normalisations above, recursively.
 *
 * Recursive because selectors return records nested inside other shapes — a
 * `CitySignal` holds a `City` and a `CommunityEvent`, a `PhotoRecordItem`
 * holds an event, `coHostsOf()` returns builders, and so on. A field that only
 * differs three levels down still differs.
 */
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise);
  if (value instanceof Date) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const isEvent = isEventShape(record);
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(record)) {
      if ((DROPPED as readonly string[]).includes(key)) continue;
      if (key === 'createdAt' && isEvent) continue;

      if (key === 'roles' && Array.isArray(nested)) {
        // Compared in full, minus the one value that cannot mean anything here.
        out[key] = (nested as string[]).filter((role) => role !== 'ambassador');
        continue;
      }
      out[key] = normalise(nested);
    }
    return out;
  }
  return value;
}

/**
 * Run one selector against both sources and compare.
 *
 * Named so a failure reads as the surface a visitor would see rather than as
 * an anonymous assertion.
 */
function compare<T>(what: string, read: () => T): void {
  const ts = against(fromTs, read);
  const database = against(fromDb, read);
  expect(
    normalise(database),
    `${what} differs between DATA_SOURCE=ts and DATA_SOURCE=db`,
  ).toEqual(normalise(ts));
}

/**
 * Compare with nothing normalised at all.
 *
 * For the surfaces where a date IS the content — the feed and the timeline are
 * lists of dated things, and normalising the date out of them would compare
 * two lists of labels and prove nothing.
 */
function compareExactly<T>(what: string, read: () => T): void {
  const ts = against(fromTs, read);
  const database = against(fromDb, read);
  expect(database, `${what} differs between DATA_SOURCE=ts and DATA_SOURCE=db`).toEqual(ts);
}

const isPublicRecord = (r: { status: string }): boolean =>
  r.status === 'published' || r.status === 'featured';

// =========================================================================

describe('the default source', () => {
  it('is ts, so an unset DATA_SOURCE never reads a database', () => {
    expect(dataSourceName({})).toBe('ts');
    expect(dataSourceName({ DATA_SOURCE: '' })).toBe('ts');
    expect(dataSourceName({ DATA_SOURCE: 'ts' })).toBe('ts');
    expect(dataSourceName({ DATA_SOURCE: 'db' })).toBe('db');
  });

  it('refuses an unrecognised value rather than falling back', () => {
    // A typo silently building from TypeScript is how somebody comes to
    // believe they verified the database path having verified nothing.
    expect(() => dataSourceName({ DATA_SOURCE: 'database' })).toThrow(/not a data source/);
    expect(() => dataSourceName({ DATA_SOURCE: 'postgres' })).toThrow(/not a data source/);
  });
});

// ── The records themselves ──────────────────────────────────────────────

describe('records', () => {
  /**
   * THE FIELDS EXCLUDED FROM THE FIELD-BY-FIELD COMPARISON, AND WHY.
   *
   * Every one of these was found by this suite failing against real Neon,
   * investigated, and is excluded because the difference is either invisible
   * to any reader or the database being MORE correct than the TypeScript
   * record — never less. Nothing here is excluded to make the comparison
   * pass; the rendered consequence of each is asserted separately, and the
   * selectors that read them are compared in full elsewhere in this file.
   *
   *   id          The record authors ids by hand (`prj-navdisha`); the
   *               database generates uuids. Nothing renders an entity id —
   *               `CommunitySearch.astro` renders a SEARCH record id
   *               (`project:navdisha`), which is derived from the slug. The
   *               slug is the identity the site actually uses, and it is
   *               compared as the comparison key.
   *
   *   createdAt   CONVERGED, not merely excluded. The Impact Lab cohort of
   *               projects was backfilled into `src/data/projects.ts` with
   *               the same evidenced date the importer derives (`2026-08-23`
   *               — the day the lab was held, stated in each project's own
   *               summary), specifically so the two sources would agree on a
   *               fact both can support. It is still normalised out of THIS
   *               generic field sweep because events also carry an evidenced
   *               `createdAt` the record leaves unset (their own `date` field
   *               carries the same fact and is compared directly) — the
   *               timeline and activity feed, where a date actually renders,
   *               are compared exactly, dates included, further down.
   *
   *   updatedAt   DROPPED, PERMANENTLY — a different case from `createdAt`.
   *               `createdAt` converges because the record was backfilled
   *               with the same evidenced date the database derives;
   *               `updatedAt` cannot converge that way, because the record
   *               has no notion of "last modified" at all and never will —
   *               there is nothing to backfill it WITH. Every database write,
   *               even a correct one (this migration's own `position`
   *               backfill is an example), legitimately advances it, and the
   *               TypeScript side stays `undefined` forever. That is not a
   *               bug; it is what a version-controlled file and a mutable
   *               database structurally ARE.
   *
   *               It renders today on exactly two page types —
   *               `stories/[slug].astro` and `use-cases/[slug].astro`, both
   *               as a "modified" date — and there are currently zero rows of
   *               either kind in the record, so nothing is rendering it live.
   *               If that changes, the property that actually matters —
   *               advances only on a genuine content change, never on a no-op
   *               re-import — is guarded by `tests/import.test.ts`'s
   *               "updated_at reflects a real change, not a real import"
   *               suite, against a real PostgreSQL.
   *
   *   roles       The database refuses to store `ambassador` in
   *               `builders.roles` (a CHECK — nobody makes themselves an
   *               ambassador), so it comes back stripped. Both places that
   *               render roles already filter the same value out defensively,
   *               so the rendered chips are identical. Asserted below.
   *
   *   eventSlugs  The database knows MORE rooms than the record declares. It
   *               reconstructs the list from the three real credits —
   *               co-hosted, spoke, attended — where the record has a
   *               hand-declared list that is sometimes short of them.
   *               `eventsOf()` unions declared with credited, so the rendered
   *               result is the same; it is compared per builder below.
   *
   *   projectSlugs Absent from the database side, because every declared entry
   *               in the repository is also a credit on the project itself, so
   *               `projectsOf()` — which unions the two — returns the same
   *               list. Compared per builder below.
   */
  const EXPLAINED = new Set([
    'id',
    'createdAt',
    'updatedAt',
    'roles',
    'eventSlugs',
    'projectSlugs',
  ]);

  for (const key of RECORD_KEYS) {
    it(`${key} are identical`, () => {
      /**
       * `builders` is the one table the reader loads past the publication
       * predicate, because a `pending` builder's NAME is still a credit the
       * record owes them — see the header of `source-db.ts`. Everything else
       * leaves the database already filtered, so the TypeScript side is
       * filtered to match before comparing.
       */
      const expected = key === 'builders' ? fromTs[key] : fromTs[key].filter(isPublicRecord);

      // Compared slug-by-slug so a failure names the record rather than
      // printing two arrays and leaving the reader to find the difference.
      const bySlug = (list: { slug: string }[]) =>
        new Map(list.map((record) => [record.slug, record]));
      const wanted = bySlug(expected);
      const got = bySlug(fromDb[key]);

      expect([...got.keys()].sort()).toEqual([...wanted.keys()].sort());

      for (const [slug, record] of wanted) {
        const actual = got.get(slug) as Record<string, unknown>;
        const ts = record as unknown as Record<string, unknown>;

        // Every field EXCEPT the five explained above must match exactly.
        const fields = new Set([...Object.keys(ts), ...Object.keys(actual)]);
        for (const field of fields) {
          if (EXPLAINED.has(field)) continue;
          expect(actual[field], `${key}/${slug}.${field} differs`).toEqual(ts[field]);
        }
      }
    });
  }

  it('gains a date only where the database has evidence for one', () => {
    /**
     * THE ONE PLACE THE TWO SOURCES GENUINELY DIFFER, stated as a fact rather
     * than normalised away.
     *
     * The importer derives two evidenced timestamps the TypeScript record does
     * not carry. This asserts exactly which records gain one, so the
     * difference is pinned: if it ever widens — a builder, a story, a use case
     * or a guide starts arriving with a date out of nowhere — this fails and
     * names the record.
     */
    const gained = (
      database: { slug: string; createdAt?: string }[],
      typescript: { slug: string; createdAt?: string }[],
    ): string[] => {
      const before = new Map(typescript.map((r) => [r.slug, r.createdAt]));
      return database
        .filter((r) => r.createdAt && !before.get(r.slug))
        .map((r) => r.slug)
        .sort();
    };

    // Events: every one, from the day it was held.
    expect(gained(fromDb.events, fromTs.events)).toEqual(
      fromTs.events.filter(isPublicRecord).map((e) => e.slug).sort(),
    );

    /**
     * Projects gain nothing any more. The Impact Lab date was backfilled into
     * `src/data/projects.ts`, because it is evidenced — each of those records
     * states "Submitted at Bhopal Impact Lab · 23 Aug 2026" in its own summary
     * and the event was held that day. Both sources now carry the same true
     * fact, which is the right way for two sources to agree.
     */
    expect(gained(fromDb.projects, fromTs.projects)).toEqual([]);

    // Builders: the same cohort, and NOT the public directory.
    const gainedBuilders = gained(fromDb.builders, fromTs.builders);
    expect(gainedBuilders.length).toBeGreaterThan(0);
    for (const slug of gainedBuilders) {
      const builder = fromDb.builders.find((b) => b.slug === slug)!;
      expect(isPublicRecord(builder), `${slug} is public and gained a date`).toBe(false);
    }

    // And nowhere else. These four carry no evidenced date at all.
    expect(gained(fromDb.cities, fromTs.cities)).toEqual([]);
    expect(gained(fromDb.stories, fromTs.stories)).toEqual([]);
    expect(gained(fromDb.useCases, fromTs.useCases)).toEqual([]);
    expect(gained(fromDb.guides, fromTs.guides)).toEqual([]);
  });

  it('renders the same role chips despite the ambassador CHECK', () => {
    /**
     * The database strips `ambassador` from `builders.roles`. Both places that
     * render roles filter the same value out themselves, so this asserts what
     * a reader would see: the filtered lists are equal.
     */
    const chips = (list: { slug: string; roles: string[] }[]) =>
      new Map(list.map((b) => [b.slug, b.roles.filter((role) => role !== 'ambassador')]));

    const ts = chips(fromTs.builders);
    const database = chips(fromDb.builders);
    for (const [slug, roles] of ts) {
      expect(database.get(slug), `${slug} renders different role chips`).toEqual(roles);
    }
  });
});

// ── The publication predicate ───────────────────────────────────────────

/**
 * READ-ONLY AGAINST THIS DATABASE, DELIBERATELY.
 *
 * `tests/equivalence.test.ts` (PGlite) exhaustively proves the publication
 * predicate by MUTATING rows through every status and back — that requires a
 * transaction to be safe, and `neon-http` cannot open one (it is a stateless
 * HTTP driver, by design — see `db/client.ts`). Running the same mutate-and-
 * restore pattern against the real Neon instance that Step 3 just imported,
 * with no transaction to guarantee the restore actually happens, is a risk
 * this verification run has no business taking against data the user asked
 * to keep. The task for this step is READ verification, not a rehearsal of
 * logic PGlite already covers.
 *
 * So this section asserts the predicate the same way, but by READING the
 * state Neon is actually in rather than by forcing it through states nobody
 * is currently in. It is a weaker test than the PGlite one in coverage and a
 * stronger one in honesty about what it touched.
 */
describe('public filtering (read-only against Neon)', () => {
  it('contains only published content — every loaded record is published or featured', () => {
    // If the reader's WHERE clause were ever wrong, this is what would catch
    // it: every single row that came back would need to already carry a
    // status other than published/featured for this to fail, which is exactly
    // what the SQL predicate claims to prevent.
    for (const key of RECORD_KEYS) {
      if (key === 'builders') continue; // the one table read past the predicate — see header
      for (const record of fromDb[key]) {
        expect(
          ['published', 'featured'],
          `${key}/${(record as { slug: string }).slug} has status "${(record as { status: string }).status}"`,
        ).toContain((record as { status: string }).status);
      }
    }
  });

  it('treats approved as not yet public', () => {
    // §4 and §5. Approval is an editorial decision; publication is a separate
    // act tied to a build. This is the assertion that keeps the two apart.
    expect(NON_PUBLIC_CONTENT_STATUSES).toContain('approved');
  });

  it('keeps featured a display flag rather than a status', () => {
    // A featured record is `published` AND `featured`. There is no `featured`
    // content status, and reintroducing one would make a display decision
    // look like a review decision.
    expect([...NON_PUBLIC_CONTENT_STATUSES] as string[]).not.toContain('featured');
    for (const event of fromDb.events) {
      expect(['published', 'featured']).toContain(event.status);
    }
  });
});

/**
 * The MUTATING half of the publication-predicate proof — including archive —
 * is exercised in `tests/equivalence.test.ts` against PGlite, and in
 * `tests/admin-publishing.test.ts`'s "archives a published record without
 * deleting it" against PGlite as well. Both are real PostgreSQL with real
 * transactions. Not repeated here, for the reason above.
 */

// ── Derived selectors ───────────────────────────────────────────────────

describe('derived selectors', () => {
  it('nationalSignal is identical', () => {
    compare('nationalSignal()', () => selectors.nationalSignal(NOW));
  });

  /**
   * `citySignals()` and `citiesInState()` carry NO ordering contract — see
   * their doc comments in `src/data/index.ts`. `citySignals()` is
   * `publicCities.map(...)`, in whatever order the source happened to iterate
   * `publicCities`, and nothing renders that raw order: both `CityAtlas.astro`
   * and `CityIndex.astro` read `citySignalsRanked()`, which imposes its own
   * total order (state rank, then name) independent of input order. PGlite
   * happens to preserve TS's declared array order because rows are inserted
   * into an empty table one at a time in that order; real Neon, after a
   * migration and re-imports, has no reason to and does not have to — nothing
   * downstream depends on it. So the unordered pair is compared as sets, and
   * the one function with a real rendering contract is compared as a sequence.
   */
  it('city state is identical for every city', () => {
    const bySlug = (signals: ReturnType<typeof selectors.citySignals>) =>
      new Map(signals.map((s) => [s.city.slug, s]));

    compare('citySignals() as a set', () => {
      const signals = selectors.citySignals(NOW);
      return [...bySlug(signals).keys()].sort();
    });
    for (const [slug, signal] of bySlug(against(fromTs, () => selectors.citySignals(NOW)))) {
      compare(`citySignals()/${slug}`, () => bySlug(selectors.citySignals(NOW)).get(slug));
    }

    // THE ONE WITH A RENDERING CONTRACT: order matters, so it is compared as
    // an exact sequence, not just as a set.
    compare('citySignalsRanked()', () => selectors.citySignalsRanked(NOW));

    for (const state of [
      'ambassador-led',
      'event-activity',
      'community-interest',
      'discovery',
    ] as const) {
      compare(`citiesInState(${state}) as a set`, () =>
        [...bySlug(selectors.citiesInState(state, NOW)).keys()].sort(),
      );
    }
  });

  /**
   * THE TIMELINE AND THE FEED ARE COMPARED EXACTLY, dates included.
   *
   * These two surfaces are lists of dated things, so normalising the date out
   * of them would compare two lists of labels and prove nothing. They are also
   * the only surfaces the evidenced `createdAt` above could reach, which makes
   * them the load-bearing comparison for that whole difference.
   *
   * They are equal because the records that gain a date are the ones these
   * surfaces already exclude: `assembleSignals()` reads `publicBuilders` and
   * `publicProjects`, and the Impact Lab cohort is `pending`. The projects
   * built there are `published` and DO gain a date — and they appear in both
   * feeds identically, because the TypeScript side reads the same
   * `builtAtEventSlug` and the feed is ordered by date with events dominating
   * it.
   *
   * If that ever stops being true, this fails with the two feeds side by side,
   * which is exactly the signal wanted.
   */
  it('the timeline is identical, dates included', () => {
    compareExactly('timeline()', () => selectors.timeline(NOW));
  });

  it('the activity feed is identical, dates included', () => {
    compareExactly('communitySignal()', () => selectors.communitySignal(6, NOW));
    // A high limit too, so the comparison covers the whole feed rather than
    // whatever fits in the default six.
    compareExactly('communitySignal(500)', () => selectors.communitySignal(500, NOW));
  });

  it('the photographic record is identical', () => {
    compare('photoRecord()', () => selectors.photoRecord());
  });

  it('event lifecycle selectors are identical', () => {
    compare('eventsChronological', () => selectors.eventsChronological);
    compare('upcomingEvents()', () => selectors.upcomingEvents(NOW));
    compare('pastEvents()', () => selectors.pastEvents(NOW));
    compare('nextEvent()', () => selectors.nextEvent(NOW));
    compare('liveEvents()', () => selectors.liveEvents(NOW));
  });

  it('the public subsets are identical', () => {
    compare('publicAmbassadors', () => selectors.publicAmbassadors);
    compare('publicBuilders', () => selectors.publicBuilders);
    compare('publicCities', () => selectors.publicCities);
    compare('publicEvents', () => selectors.publicEvents);
    compare('publicGuides', () => selectors.publicGuides);
    compare('publicProjects', () => selectors.publicProjects);
    compare('publicStories', () => selectors.publicStories);
    compare('publicUseCases', () => selectors.publicUseCases);
  });

  it('the practice library is identical', () => {
    compare('useCasesChronological()', () => selectors.useCasesChronological());
    compare('guidesChronological()', () => selectors.guidesChronological());
    compare('storiesChronological()', () => selectors.storiesChronological());
    compare('claudeSurfaces()', () => selectors.claudeSurfaces());
  });
});

// ── The community graph, walked per record ──────────────────────────────

describe('the community graph', () => {
  it('resolves every city the same way', () => {
    for (const { slug } of fromTs.cities) {
      compare(`getCity(${slug})`, () => selectors.getCity(slug));
      compare(`cityName(${slug})`, () => selectors.cityName(slug));
      compare(`citySignal(${slug})`, () => {
        const city = selectors.getCity(slug);
        return city ? selectors.citySignal(city, NOW) : undefined;
      });
      compare(`eventsInCity(${slug})`, () => selectors.eventsInCity(slug));
      compare(`buildersInCity(${slug})`, () => selectors.buildersInCity(slug));
      compare(`projectsInCity(${slug})`, () => selectors.projectsInCity(slug));
      compare(`storiesInCity(${slug})`, () => selectors.storiesInCity(slug));
      compare(`useCasesInCity(${slug})`, () => selectors.useCasesInCity(slug));
      compare(`ambassadorsInCity(${slug})`, () => selectors.ambassadorsInCity(slug));
      compare(`nextEventInCity(${slug})`, () => selectors.nextEventInCity(slug, NOW));
    }
  });

  it('credits every event the same way', () => {
    for (const { slug } of fromTs.events.filter(isPublicRecord)) {
      const onEvent =
        <T>(read: (event: selectors.CommunityEvent) => T) =>
        () => {
          const event = selectors.eventBySlug.get(slug);
          return event ? read(event) : undefined;
        };
      compare(`creditsFor(${slug})`, onEvent((e) => selectors.creditsFor(e)));
      compare(`venueLabel(${slug})`, onEvent((e) => selectors.venueLabel(e)));
      compare(`hostAmbassador(${slug})`, onEvent((e) => selectors.hostAmbassador(e)));
      compare(`isAmbassadorLed(${slug})`, onEvent((e) => selectors.isAmbassadorLed(e)));
      compare(`coHostsOf(${slug})`, onEvent((e) => selectors.coHostsOf(e)));
      compare(`speakersOf(${slug})`, onEvent((e) => selectors.speakersOf(e)));
      compare(`projectsFromEvent(${slug})`, () => selectors.projectsFromEvent(slug));
      compare(`useCasesForEvent(${slug})`, () => selectors.useCasesForEvent(slug));
      compare(`guidesForEvent(${slug})`, () => selectors.guidesForEvent(slug));
      compare(`storiesForEvent(${slug})`, () => selectors.storiesForEvent(slug));
    }
  });

  it('never loses a declared credit, and may know more', () => {
    /**
     * The claim that makes dropping `eventSlugs` and `projectSlugs` from the
     * structural comparison safe: the database's list contains everything the
     * record declares. An extra entry is an additional true credit — somebody
     * who co-hosted a room without the hand-written list saying so. A MISSING
     * entry would be a credit silently dropped, and this is what would catch
     * it.
     */
    for (const builder of fromTs.builders) {
      const database = fromDb.builders.find((b) => b.slug === builder.slug)!;

      for (const field of ['eventSlugs', 'projectSlugs'] as const) {
        const declared = builder[field] ?? [];
        const derived = new Set(database[field] ?? []);
        const lost = declared.filter((slug) => !derived.has(slug));

        if (field === 'eventSlugs') {
          expect(lost, `${builder.slug} lost declared ${field}`).toEqual([]);
        } else {
          /**
           * `projectSlugs` is absent from the database side entirely, because
           * every declared entry is also a credit on the project itself — so
           * the credit survives, on the project. Asserted as exactly that
           * rather than as a superset.
           */
          const credits = fromDb.projects
            .filter((p) => p.builderSlugs.includes(builder.slug))
            .map((p) => p.slug);
          const stillCredited = new Set(credits);
          expect(
            declared.filter((slug) => !stillCredited.has(slug)),
            `${builder.slug} lost declared ${field} and it is not a project credit either`,
          ).toEqual([]);
        }
      }
    }
  });

  it('resolves every builder the same way', () => {
    // Walked over ALL builders, not just public ones: the pending Impact Lab
    // cohort is exactly where a reader mistake would hide.
    for (const { slug } of fromTs.builders) {
      const onBuilder =
        <T>(read: (builder: selectors.Builder) => T) =>
        () => {
          const builder = selectors.builders.find((b) => b.slug === slug);
          return builder ? read(builder) : undefined;
        };
      compare(`projectsOf(${slug})`, onBuilder((b) => selectors.projectsOf(b)));
      compare(`eventsOf(${slug})`, onBuilder((b) => selectors.eventsOf(b)));
      compare(`ambassadorForBuilder(${slug})`, onBuilder((b) => selectors.ambassadorForBuilder(b)));
      compare(`useCasesBy(${slug})`, () => selectors.useCasesBy(slug));
      compare(`guidesBy(${slug})`, () => selectors.guidesBy(slug));
    }
  });

  it('attributes every project the same way', () => {
    for (const { slug } of fromTs.projects.filter(isPublicRecord)) {
      const onProject =
        <T>(read: (project: selectors.Project) => T) =>
        () => {
          const project = selectors.projects.find((p) => p.slug === slug);
          return project ? read(project) : undefined;
        };
      compare(`buildersOf(${slug})`, onProject((p) => selectors.buildersOf(p)));
      // The pending-builder attribution path. A dropped credit here would be
      // a person's name silently vanishing from work they did.
      compare(`builderNamesOf(${slug})`, onProject((p) => selectors.builderNamesOf(p)));
      compare(`useCasesForProject(${slug})`, () => selectors.useCasesForProject(slug));
    }
  });

  it('resolves every byline the same way', () => {
    for (const { slug } of fromTs.useCases.filter(isPublicRecord)) {
      compare(`authorOf(use-case/${slug})`, () => {
        const record = selectors.useCaseBySlug.get(slug);
        return record ? selectors.authorOf(record) : undefined;
      });
      compare(`authorName(use-case/${slug})`, () => {
        const record = selectors.useCaseBySlug.get(slug);
        return record ? selectors.authorName(record) : undefined;
      });
    }
    for (const { slug } of fromTs.guides.filter(isPublicRecord)) {
      compare(`authorName(guide/${slug})`, () => {
        const record = selectors.guideBySlug.get(slug);
        return record ? selectors.authorName(record) : undefined;
      });
    }
  });

  it('builds the same lookup maps', () => {
    const keys = (map: Map<string, unknown>): string[] => [...map.keys()].sort();
    compare('cityBySlug', () => keys(selectors.cityBySlug));
    compare('eventBySlug', () => keys(selectors.eventBySlug));
    compare('builderBySlug', () => keys(selectors.builderBySlug));
    compare('projectBySlug', () => keys(selectors.projectBySlug));
    compare('storyBySlug', () => keys(selectors.storyBySlug));
    compare('ambassadorBySlug', () => keys(selectors.ambassadorBySlug));
    compare('useCaseBySlug', () => keys(selectors.useCaseBySlug));
    compare('guideBySlug', () => keys(selectors.guideBySlug));
  });
});

// ── Search ──────────────────────────────────────────────────────────────

describe('search', () => {
  it('produces an identical index', () => {
    compare('buildSearchIndex()', () => buildSearchIndex(NOW));
  });

  it('produces an identical vocabulary', () => {
    compare('searchVocabulary()', () => searchVocabulary());
  });
});

// ── Indexability and the sitemap ────────────────────────────────────────

describe('indexability', () => {
  it('marks the same cities indexable', () => {
    compare('nonIndexablePaths()', () => [...nonIndexablePaths()].sort());
    compare('indexableCityPaths()', () => [...indexableCityPaths()].sort());
    for (const { slug } of fromTs.cities) {
      compare(`isCityIndexable(${slug})`, () => {
        const city = selectors.getCity(slug);
        return city ? isCityIndexable(city) : undefined;
      });
    }
  });

  /**
   * The mutating version of this check — set every city to `approved` and
   * confirm the sitemap goes empty — runs in `tests/equivalence.test.ts`
   * against PGlite. Blanket-updating every row in Neon's `cities` table with
   * no WHERE clause is not a risk this read-only verification takes, so this
   * asserts the same rule from the data Neon is actually holding: nothing
   * short of `published`/`featured` appears in the loaded set at all, which is
   * what makes an unpublished route structurally impossible to advertise
   * rather than merely untested.
   */
  it('never advertises an unpublished record', () => {
    for (const city of fromDb.cities) {
      expect(['published', 'featured']).toContain(city.status);
    }
    // And the indexable/non-indexable partition accounts for every city.
    const total = indexableCityPaths().length + nonIndexablePaths().length;
    expect(total).toBe(fromDb.cities.length);
  });
});

// ── The route set ───────────────────────────────────────────────────────

describe('routes', () => {
  /**
   * Every route the site generates from a record.
   *
   * Derived from the same `public*` selectors the pages' `getStaticPaths` read,
   * so this is the actual page set rather than a list maintained beside it.
   */
  const routes = (): string[] =>
    [
      ...selectors.publicCities.map((c) => `/cities/${c.slug}`),
      ...selectors.publicEvents.map((e) => `/events/${e.slug}`),
      ...selectors.publicBuilders.map((b) => `/builders/${b.slug}`),
      ...selectors.publicProjects.map((p) => `/projects/${p.slug}`),
      ...selectors.publicStories.map((s) => `/stories/${s.slug}`),
      ...selectors.publicUseCases.map((u) => `/use-cases/${u.slug}`),
      ...selectors.publicGuides.map((g) => `/guides/${g.slug}`),
    ].sort();

  it('generates the same routes', () => {
    compare('the generated route set', routes);
  });
});
