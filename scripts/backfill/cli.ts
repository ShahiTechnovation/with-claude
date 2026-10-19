#!/usr/bin/env tsx
/**
 * THE EVENT-PHOTOGRAPH BACKFILL.
 *
 *   npm run backfill:photos -- plan     [--with-dimensions] [--allow-remote-db]
 *   npm run backfill:photos -- rehearse [--with-dimensions]
 *   npm run backfill:photos -- apply    --yes [--with-dimensions] [--allow-remote-db]
 *   npm run backfill:photos -- rollback --receipt imports/<file>.json --yes [--allow-remote-db]
 *
 * plan      the dry run: reads the target database, writes nothing, and prints
 *           the exact row delta `apply` would produce plus the rollback SQL.
 *           This is the only thing that can tell you the real `event_photos`
 *           number — see `unknownEventSlugs` in `./event-photos.ts`
 * rehearse  the same dry run against PGlite — PostgreSQL in this process —
 *           seeded to the `81fe1e7` baseline. Needs no DATABASE_URL and can
 *           reach nothing. A real target is ahead of that baseline by
 *           whatever earlier applies landed, so its `plan` prints less
 * apply     the two inserts and the dimension update, in one transaction, and
 *           writes a receipt to `imports/` (git-ignored)
 * rollback  deletes exactly the rows a receipt records inserting, and exits 2
 *           when it deleted none of them. A `--with-dimensions` width/height
 *           update is NOT reversed — the receipt keeps the previous values
 *           under `dimensionsUpdated[].was` for a human to restore, because
 *           putting a null back would restore the defect rather than the state
 *
 * `plan` and `apply` end the same way, through `planOutcome`: exit 2 when
 * `apply` refuses the plan, or when plates are out of order and there is
 * nothing else to write, because a plain apply cannot move a plate; exit 0
 * otherwise.
 *
 * Why this exists instead of `npm run db:import`, and what it will and will not
 * touch: `scripts/backfill/event-photos.ts`.
 *
 * Environment: DATABASE_URL only. No Baserow, no token, no network beyond the
 * database — the photographs are in git.
 *
 * `--with-dimensions` adds the one statement that modifies rows the target
 * already has: `width`/`height` on existing `media` rows, measured off the
 * files. Off by default so the run worth approving is pure-insert — nothing
 * rendering today reads those columns for an event photograph.
 *
 * Safety rails, the same ones `scripts/import/cli.ts` uses and for the same
 * reasons: apply and rollback need `--yes`, and a non-local DATABASE_URL needs
 * `--allow-remote-db`. Both are enforced through `../import/lib/cli-env`.
 */
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { databaseUrl } from '../../db/env';
import { pooledDb } from '../../db/pool';
import { fail, flag, guardDatabase, option } from '../import/lib/cli-env';
import {
  applyBackfill,
  buildBackfillPlan,
  isApplicable,
  LIVE_SIX,
  renderPlan,
  renderPlannedRollbackSql,
  rollbackBackfill,
  type BackfillPlan,
  type BackfillReceipt,
} from './event-photos';

const [command] = process.argv.slice(2);

/** Host and database name, for the receipt and the log. Never the URL itself. */
function target(): { databaseHost: string; databaseName: string } {
  try {
    const url = new URL(databaseUrl());
    return {
      databaseHost: url.hostname,
      databaseName: url.pathname.replace(/^\//, '') || 'unknown',
    };
  } catch {
    return { databaseHost: 'unknown', databaseName: 'unknown' };
  }
}

/**
 * The whole dry run: the delta, the undo for it, and how to tell afterwards.
 *
 * The rollback is printed here rather than described, so reading the dry run
 * is enough to know how to reverse the thing it proposes. `apply` writes the
 * id-exact version into its receipt.
 */
function report(built: Awaited<ReturnType<typeof buildBackfillPlan>>) {
  console.log(`\n${renderPlan(built)}\n`);
  if (built.mediaInserts.length) {
    console.log('ROLLBACK for the delta above — reversible without a restore:\n');
    console.log(renderPlannedRollbackSql(built));
    console.log(
      '\n`apply` also writes this into its receipt, keyed on the ids it actually inserted.',
    );
  }
  // The expected counts come from the plan, never a fixed number: if an event
  // is missing from the target, a fixed number would be wrong. Same for
  // `undescribedLiveRows`: a target carrying an event_photos row the record
  // does not describe reads one more than the record would, and a correct run
  // must not look like a failure.
  const photos = built.photosAlreadyPresent + built.photoInserts.length + built.undescribedLiveRows;
  const media = built.mediaAlreadyPresent + built.mediaInserts.length;
  console.log('\nVERIFY after applying:');
  console.log(`  SELECT count(*) FROM event_photos;              -- expect ${photos}`);
  console.log(
    `  SELECT count(*) FROM media WHERE kind='photo';  -- expect ${media} for the record's`,
  );
  console.log(
    '                                                     paths, plus any photo row this',
  );
  console.log('                                                     database holds outside it');
  if (built.unknownEventSlugs.length) {
    console.log(
      `  ${built.photosSkippedForMissingEvent} photograph(s) are not in that count: ${built.unknownEventSlugs.length} photo-bearing event(s) have no row here.`,
    );
  }
  // The one claim in this operation that no file in the repo can settle.
  console.log('\nWORTH ONE QUERY FIRST — this repo cannot tell you about an uncommitted trigger:');
  console.log(
    "  SELECT tgname FROM pg_trigger WHERE tgrelid = 'media'::regclass AND NOT tgisinternal;",
  );
  console.log(
    '  Expect no rows. `media.updated_at` is left alone on the strength of there being none.',
  );
  console.log(
    '  /gallery: the photograph count there is derived from what rendered, so it is a real check.',
  );
}

async function plan() {
  guardDatabase();
  // Pooled on purpose: this operation is one transaction, and Neon's HTTP
  // driver cannot open one. `db/pool.ts` picks the driver from the host.
  const built = await buildBackfillPlan(pooledDb(), { withDimensions: flag('with-dimensions') });
  report(built);
  exitWith(planOutcome(built) ?? { lines: [], code: 0 });
}

/**
 * The dry run against PGlite, seeded to the `81fe1e7` baseline.
 *
 * The same precedent as `scripts/snapshot-from-pglite.ts`: PostgreSQL compiled
 * to WebAssembly, running here, with the committed migrations and the real
 * importer. Nothing is faked: the same planner and the same constraint engine.
 * What differs from Neon is the transport and the data: the seed keeps the
 * plates commit `81fe1e7` added (`LIVE_SIX`) and drops every photograph added
 * since, so it prints the whole backlog from that baseline. A real target is
 * ahead of it by whatever earlier applies landed (`imports/*.json`).
 */
async function rehearse() {
  const { createTestDatabase } = await import('../../db/testing');
  const { importRecords } = await import('../../db/import');
  const { and, eq, inArray, notInArray } = await import('drizzle-orm');
  const schema = await import('../../db/schema');

  console.log(
    'Database: PGlite, in this process. A rehearsal — it can reach nothing and DATABASE_URL is not read.',
  );
  const db = await createTestDatabase();
  try {
    await importRecords(db as never);
    const stale = await db
      .select({ id: schema.media.id })
      .from(schema.media)
      .where(and(eq(schema.media.kind, 'photo'), notInArray(schema.media.path, LIVE_SIX)));
    const staleIds = stale.map((row) => row.id);
    if (staleIds.length) {
      await db.delete(schema.eventPhotos).where(inArray(schema.eventPhotos.mediaId, staleIds));
      await db.delete(schema.media).where(inArray(schema.media.id, staleIds));
    }
    console.log(
      `Seeded to the 81fe1e7 baseline: the ${LIVE_SIX.length} plates that commit added.\n`,
    );

    report(await buildBackfillPlan(db as never, { withDimensions: flag('with-dimensions') }));
    console.log(
      '\nThe delta from the 81fe1e7 baseline. Against a real target `plan` prints less, by whatever ' +
        'earlier applies landed (see imports/*.json). Nothing was written anywhere.',
    );
  } finally {
    await db.$close();
  }
  process.exit(0);
}

/**
 * The write.
 *
 * Unlike `npm run import -- apply`, this does not consume a plan file. It
 * rebuilds the plan against the database it is about to write to and prints it
 * again, so what you approve with `--yes` is the delta it then writes rather
 * than one computed earlier against a database that may have moved. The
 * importer needs a saved plan because a human edits the decisions in it; there
 * is nothing to decide here.
 */
async function apply() {
  if (!flag('yes'))
    fail('apply writes to the database. Run `plan` first, read the delta, then re-run with --yes.');
  guardDatabase();
  const db = pooledDb();
  const built = await buildBackfillPlan(db, { withDimensions: flag('with-dimensions') });
  report(built);
  const outcome = planOutcome(built);
  if (outcome) exitWith(outcome);

  const receipt = await applyBackfill(db, built, target());
  process.exit(await emitReceipt(receipt));
}

/** What a command says, and its exit code. Returned, not printed, so a test can read both. */
export interface Outcome {
  lines: string[];
  code: number;
}

/** Print an outcome, on stdout for a 0 and stderr for anything else, and exit with its code. */
export function exitWith({ lines, code }: Outcome): never {
  const print = code ? console.error : console.log;
  for (const line of lines) print(line);
  process.exit(code);
}

/**
 * How `plan` and `apply` end when `apply` would write nothing, or null when it
 * would write. Both call it, so they cannot disagree. The refusal comes first:
 * a refused plan can also have nothing to write (a stale live row is one), and
 * "Nothing to do" would hide the refusal.
 */
export function planOutcome(plan: BackfillPlan): Outcome | null {
  if (!isApplicable(plan)) {
    return { lines: ['Refusing to apply: see the refusals above.'], code: 2 };
  }
  return nothingToDo(plan);
}

/**
 * `apply` with nothing to write, or null when there is something.
 *
 * Not plain "nothing to do" while DRIFT or MISSING EVENTS is printed above it.
 * The order is part of the record, and this script only appends, so it cannot
 * move a plate: exit 2. A photograph waiting for its event is not a refusal
 * (see `unknownEventSlugs`), so that exits 0, and says what is still to come.
 */
export function nothingToDo(
  plan: Pick<
    BackfillPlan,
    | 'mediaInserts'
    | 'photoInserts'
    | 'dimensionUpdates'
    | 'positionDrift'
    | 'photosSkippedForMissingEvent'
  >,
): Outcome | null {
  if (plan.mediaInserts.length || plan.photoInserts.length || plan.dimensionUpdates.length)
    return null;
  if (plan.positionDrift.length) {
    return {
      lines: [
        `${plan.positionDrift.length} plate(s) are in a different order here than in the record, and a plain ` +
          'apply cannot move them. Roll back the receipt that inserted them, then apply again.',
      ],
      code: 2,
    };
  }
  if (plan.photosSkippedForMissingEvent) {
    return {
      lines: [
        `Nothing to write yet: ${plan.photosSkippedForMissingEvent} photograph(s) wait for event rows this ` +
          'database lacks (MISSING EVENTS above). Apply again once they exist.',
      ],
      code: 0,
    };
  }
  return {
    lines: ['Nothing to do — this database already holds every photograph the record describes.'],
    code: 0,
  };
}

/**
 * Get the undo out of the process, after the transaction has committed.
 *
 * ORDER MATTERS HERE and it is the only place in this script where it does.
 * The rows are already committed when this is called, so nothing may throw
 * before the rollback SQL reaches stdout: if the receipt write fails first —
 * read-only cwd, full disk, `imports` existing as a file — the operator is left
 * with a successful production write and no reachable undo. A fresh `plan`
 * cannot regenerate one either, because after a successful apply there is
 * nothing left to insert and the planned-rollback renderer correctly prints
 * "nothing to undo".
 *
 * So: SQL first, file second, and a failed file write degrades to printing the
 * receipt rather than exiting with the undo unreachable.
 *
 * Separated from `apply` so a test can call it with a `writeFile` that throws.
 * Returns the exit code rather than exiting, for the same reason.
 */
export async function emitReceipt(
  receipt: BackfillReceipt,
  io: { mkdir: typeof mkdir; writeFile: typeof writeFile } = { mkdir, writeFile },
): Promise<number> {
  console.log(
    `Applied: media +${receipt.insertedMedia.length}, event_photos +${receipt.insertedPhotos.length}, ` +
      `${receipt.dimensionsUpdated.length} existing media rows given width/height.`,
  );
  console.log('\nTo undo, as SQL:\n');
  console.log(receipt.rollbackSql);

  const path = join(
    'imports',
    `backfill-event-photos-${receipt.appliedAt.replace(/[:.]/g, '-')}.json`,
  );
  try {
    await io.mkdir('imports', { recursive: true });
    await io.writeFile(path, JSON.stringify(receipt, null, 2));
  } catch (error) {
    // The write succeeded and the receipt did not. Degrade to stdout rather
    // than leaving a committed change with no undo anybody can reach.
    console.error(`\nThe backfill committed, but the receipt could not be written to ${path}:`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      '\nThe SQL above reverses it. To use `rollback --receipt` instead, save this to that path:\n',
    );
    console.error(JSON.stringify(receipt, null, 2));
    return 3;
  }

  console.log(`\nReceipt: ${path}`);
  console.log(
    `Preferred undo — it reports what it kept and why:\n  npm run backfill:photos -- rollback --receipt ${path} --yes\n`,
  );
  return 0;
}

async function rollback() {
  if (!flag('yes')) fail('rollback deletes rows. Re-run with --yes.');
  const receiptPath = option('receipt') ?? fail('--receipt imports/<file>.json is required.');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as BackfillReceipt;
  guardDatabase();
  const here = target();
  if (receipt.databaseHost !== here.databaseHost || receipt.databaseName !== here.databaseName) {
    fail(
      `That receipt was written against ${receipt.databaseName} on ${receipt.databaseHost}, and DATABASE_URL ` +
        `points at ${here.databaseName} on ${here.databaseHost}. Rolling back one database with another's ` +
        `receipt would delete the wrong rows.`,
    );
  }

  exitWith(rollbackReport(receipt, await rollbackBackfill(pooledDb(), receipt), here.databaseName));
}

/**
 * What `rollback` says about what it deleted.
 *
 * "Rolled back" only when it deleted something. A receipt whose rows are gone
 * (a superseded or already rolled-back one) deletes nothing, and saying
 * "Rolled back" with exit 0 there would let someone clearing a bad row with
 * the wrong receipt walk away thinking it was cleared.
 */
export function rollbackReport(
  receipt: BackfillReceipt,
  result: Awaited<ReturnType<typeof rollbackBackfill>>,
  databaseName: string,
): Outcome {
  const photosGone = receipt.insertedPhotos.length - result.photosDeleted;
  const details = [
    ...result.mediaRetained.map(({ path, reason }) => `  kept ${path} — ${reason}`),
    ...(result.mediaAlreadyGone
      ? [
          `  ${result.mediaAlreadyGone} media row(s) in the receipt had already been deleted by something else.`,
        ]
      : []),
    ...(photosGone
      ? [`  ${photosGone} event_photos row(s) in the receipt were already gone.`]
      : []),
  ];
  if (result.photosDeleted + result.mediaDeleted) {
    return {
      lines: [
        `Rolled back: event_photos -${result.photosDeleted}, media -${result.mediaDeleted}.`,
        ...details,
      ],
      code: 0,
    };
  }
  // Nothing deleted, so every listed row was either kept or already gone.
  const listed = receipt.insertedPhotos.length + receipt.insertedMedia.length;
  const headline =
    listed && !result.mediaRetained.length
      ? `Nothing was undone: none of the ${listed} rows this receipt lists are in ${databaseName} any more. ` +
        'If the photographs are still there, a later apply inserted them: use its receipt (ls imports/).'
      : `Nothing was undone: this receipt lists ${listed} row(s), and none was deleted from ${databaseName}.`;
  return { lines: [headline, ...details], code: 2 };
}

// Only when run as a command. Tests import `emitReceipt` and the outcome
// helpers, and a bare import must not dispatch — it would reach `default` and
// exit 1. Same guard as `scripts/dev/visual-review.mjs:154` and `db/migrate.ts:47`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  switch (command) {
    case 'plan':
      await plan();
      break;
    case 'rehearse':
      await rehearse();
      break;
    case 'apply':
      await apply();
      break;
    case 'rollback':
      await rollback();
      break;
    default:
      fail(
        'Usage: backfill:photos plan [--allow-remote-db]\n' +
          '       backfill:photos rehearse\n' +
          '       backfill:photos apply --yes [--allow-remote-db]\n' +
          '       backfill:photos rollback --receipt imports/<file>.json --yes [--allow-remote-db]',
      );
  }
}
