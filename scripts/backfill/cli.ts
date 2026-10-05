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
 *           seeded to the state production is in. Needs no DATABASE_URL and
 *           can reach nothing, so anyone can read the delta before
 *           authorising the real one
 * apply     the two inserts and the dimension update, in one transaction, and
 *           writes a receipt to `imports/` (git-ignored)
 * rollback  deletes exactly what a receipt records
 *
 * Why this exists instead of `npm run db:import`, and what it will and will not
 * touch: `scripts/backfill/event-photos.ts`.
 *
 * Environment: DATABASE_URL only. No Baserow, no token, no network beyond the
 * database — the 41 photographs are in git.
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
  type BackfillReceipt,
} from './event-photos';

const [command] = process.argv.slice(2);

/** Host and database name, for the receipt and the log. Never the URL itself. */
function target(): { databaseHost: string; databaseName: string } {
  try {
    const url = new URL(databaseUrl());
    return { databaseHost: url.hostname, databaseName: url.pathname.replace(/^\//, '') || 'unknown' };
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
    console.log('\n`apply` also writes this into its receipt, keyed on the ids it actually inserted.');
  }
  // The expected counts come from the plan, not from the issue. If an event is
  // missing from the target, 41 is not the number and saying so would be wrong.
  // Derived, never hardcoded. `undescribedLiveRows` is why: a target carrying
  // an event_photos row the record does not describe makes a correct run read
  // 42 against an "expect 41", and a correct run must not look like a failure.
  const photos = built.photosAlreadyPresent + built.photoInserts.length + built.undescribedLiveRows;
  const media = built.mediaAlreadyPresent + built.mediaInserts.length;
  console.log('\nVERIFY after applying:');
  console.log(`  SELECT count(*) FROM event_photos;              -- expect ${photos}`);
  console.log(`  SELECT count(*) FROM media WHERE kind='photo';  -- expect ${media} for the record's`);
  console.log("                                                     paths, plus any photo row this");
  console.log('                                                     database holds outside it');
  if (built.unknownEventSlugs.length) {
    console.log(
      `  ${built.photosSkippedForMissingEvent} photograph(s) are not in that count: ${built.unknownEventSlugs.length} photo-bearing event(s) have no row here.`,
    );
  }
  // The one claim in this operation that no file in the repo can settle.
  console.log('\nWORTH ONE QUERY FIRST — this repo cannot tell you about an uncommitted trigger:');
  console.log("  SELECT tgname FROM pg_trigger WHERE tgrelid = 'media'::regclass AND NOT tgisinternal;");
  console.log('  Expect no rows. `media.updated_at` is left alone on the strength of there being none.');
  console.log('  /gallery: the photograph count there is derived from what rendered, so it is a real check.');
}

async function plan() {
  guardDatabase();
  // Pooled on purpose: this operation is one transaction, and Neon's HTTP
  // driver cannot open one. `db/pool.ts` picks the driver from the host.
  const built = await buildBackfillPlan(pooledDb(), { withDimensions: flag('with-dimensions') });
  report(built);
  process.exit(isApplicable(built) ? 0 : 2);
}

/**
 * The dry run against PGlite, seeded to the state production is in.
 *
 * The same precedent as `scripts/snapshot-from-pglite.ts`: PostgreSQL compiled
 * to WebAssembly, running here, with the committed migrations and the real
 * importer. Nothing is faked — the same planner and the same constraint
 * engine, and the only difference from Neon is the transport. The seed keeps
 * the six plates the initial commit added and drops the thirty-five `2322e4c`
 * added, which is production file for file (VIS-3 `gap-baseline` §11.1).
 */
async function rehearse() {
  const { createTestDatabase } = await import('../../db/testing');
  const { importRecords } = await import('../../db/import');
  const { and, eq, inArray, notInArray } = await import('drizzle-orm');
  const schema = await import('../../db/schema');

  console.log('Database: PGlite, in this process. A rehearsal — it can reach nothing and DATABASE_URL is not read.');
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
    console.log(`Seeded to the live state: ${LIVE_SIX.length} plates, the ones 81fe1e7 added.\n`);

    report(await buildBackfillPlan(db as never, { withDimensions: flag('with-dimensions') }));
    console.log('\nThis is the delta `plan` will print against Neon. Nothing was written anywhere.');
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
  if (!flag('yes')) fail('apply writes to the database. Run `plan` first, read the delta, then re-run with --yes.');
  guardDatabase();
  const db = pooledDb();
  const built = await buildBackfillPlan(db, { withDimensions: flag('with-dimensions') });
  report(built);
  if (!isApplicable(built)) fail('Refusing to apply: see the refusals above.');
  if (!built.mediaInserts.length && !built.photoInserts.length && !built.dimensionUpdates.length) {
    console.log('Nothing to do — this database already holds every photograph the record describes.');
    process.exit(0);
  }

  const receipt = await applyBackfill(db, built, target());

  await mkdir('imports', { recursive: true });
  const path = join('imports', `backfill-event-photos-${receipt.appliedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, JSON.stringify(receipt, null, 2));

  console.log(
    `Applied: media +${receipt.insertedMedia.length}, event_photos +${receipt.insertedPhotos.length}, ` +
      `${receipt.dimensionsUpdated.length} existing media rows given width/height.`,
  );
  console.log(`Receipt: ${path}`);
  console.log(`\nTo undo:\n  npm run backfill:photos -- rollback --receipt ${path} --yes\n`);
  console.log(receipt.rollbackSql);
  process.exit(0);
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

  const result = await rollbackBackfill(pooledDb(), receipt);
  console.log(`Rolled back: event_photos -${result.photosDeleted}, media -${result.mediaDeleted}.`);
  for (const retained of result.mediaRetained) {
    console.log(`  kept ${retained.path} — ${retained.reason}`);
  }
  if (result.mediaAlreadyGone) {
    console.log(`  ${result.mediaAlreadyGone} media row(s) in the receipt had already been deleted by something else.`);
  }
  process.exit(0);
}

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
