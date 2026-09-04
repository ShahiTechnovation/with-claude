/**
 * WHERE THE PUBLIC RECORD COMES FROM.
 *
 * The public site has exactly one dataset and two possible origins for it:
 *
 *     DATA_SOURCE=ts   the TypeScript record in `src/data/*.ts`   (default)
 *     DATA_SOURCE=db   PostgreSQL, read once at build time
 *
 * ── WHY THIS IS A SHAPE AND NOT AN INTERFACE OF QUERIES ──────────────────
 *
 * The tempting design is a repository interface — `getBuilders()`,
 * `getEventsInCity()`, one method per question the site asks. It is the wrong
 * design here, and it would be the whole migration's undoing.
 *
 * `src/data/index.ts` holds around forty selectors, and every one of them is
 * domain logic: which credits an event prints and in what order, when a venue
 * is worth naming, what makes a city ambassador-led, what belongs in the
 * timeline. If the source interface were a set of queries, each of those
 * selectors would need a TypeScript implementation and a SQL implementation,
 * and "equivalent" would mean forty pairs of functions agreeing forever. They
 * would not. They would drift on the first change that only got made to one.
 *
 * So the seam is deliberately as low as it can be: a source's entire job is to
 * produce `RecordSet` — the eight record arrays, in the shapes
 * `src/data/types.ts` already defines. Every selector above it is written once
 * and reads whichever set it was handed. The database gets to answer "what are
 * the records", and nothing else. It never gets to answer "is this city
 * ambassador-led", because that question has one answer and it lives in
 * `cityState()`.
 *
 * That is what makes the equivalence suite meaningful rather than ceremonial:
 * when both sources produce an equal `RecordSet`, every selector above them is
 * provably equal too, because it is literally the same code.
 *
 * ── WHY THE DEFAULT IS `ts` ──────────────────────────────────────────────
 *
 * Because this phase is a migration, not a switch-over. `ts` is the rollback
 * path, and a rollback path that requires a code change is not one. Changing
 * an environment variable is the whole procedure.
 */
import type {
  Ambassador,
  Builder,
  City,
  CommunityEvent,
  Guide,
  Project,
  Story,
  UseCase,
} from './types';

/**
 * The complete public record, in the shapes the site already renders.
 *
 * Note that these are the FULL arrays, not the public subsets. Filtering to
 * what is publishable is `isPublic()`'s job in `src/data/index.ts`, and it
 * stays there so both sources are filtered by one predicate rather than two.
 *
 * The database source does apply a `status` predicate of its own before
 * returning rows, but as a narrowing of what leaves the database rather than
 * as a replacement for the selector — see `source-db.ts`. Both filters agree,
 * and the equivalence suite would fail if they ever stopped agreeing.
 */
export interface RecordSet {
  ambassadors: Ambassador[];
  builders: Builder[];
  cities: City[];
  events: CommunityEvent[];
  guides: Guide[];
  projects: Project[];
  stories: Story[];
  useCases: UseCase[];
}

/** The two origins. There is no third, and adding one is a decision. */
export type DataSourceName = 'ts' | 'db';

/** Every entity key in a `RecordSet`. Used by the equivalence suite. */
export const RECORD_KEYS = [
  'ambassadors',
  'builders',
  'cities',
  'events',
  'guides',
  'projects',
  'stories',
  'useCases',
] as const satisfies readonly (keyof RecordSet)[];

/**
 * Which source this build is reading.
 *
 * Defaults to `ts`, and an unrecognised value is a hard error rather than a
 * silent fallback. `DATA_SOURCE=database` quietly building from TypeScript is
 * the exact failure that would make somebody believe they had verified the
 * database path when they had verified nothing at all.
 */
export function dataSourceName(env: Record<string, string | undefined> = process.env): DataSourceName {
  const raw = (env.DATA_SOURCE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'ts') return 'ts';
  if (raw === 'db') return 'db';
  throw new Error(
    `DATA_SOURCE="${raw}" is not a data source. Use "ts" (the TypeScript record, the ` +
      `default) or "db" (PostgreSQL, read at build time).`,
  );
}
