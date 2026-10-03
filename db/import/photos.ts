/**
 * `npm run db:import:photos` — the event photos into an existing database,
 * and nothing else (see `importEventPhotos`). Add `-- --dry-run` to print what
 * it would set without writing.
 *
 * Always the pooled connection: Neon's HTTP driver cannot run a transaction.
 */
import 'dotenv/config';
import { pooledDb } from '../pool';
import { importEventPhotos } from './index';

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const { events, skipped } = await importEventPhotos(pooledDb() as never, undefined, { dryRun });

  for (const event of events) {
    console.log(`  ${event.slug.padEnd(40)} ${event.photos.length} photo(s)`);
    if (dryRun) for (const path of event.photos) console.log(`      ${path}`);
  }
  for (const slug of skipped) console.warn(`  skipped ${slug}: no event with that slug in the database`);

  const total = events.reduce((n, event) => n + event.photos.length, 0);
  console.log(
    `\n${dryRun ? 'Dry run, nothing written. Would set' : 'Set'} ${total} photos across ${events.length} events.`,
  );
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error('\nPhoto import failed. Nothing was written.\n');
  console.error(error);
  process.exit(1);
});
