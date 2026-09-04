/**
 * `npm run db:import` — the command-line entry point.
 *
 * Applies nothing and migrates nothing: it expects the schema to already be in
 * place (`npm run db:migrate`) and then copies the TypeScript record in. Run it
 * as often as you like; it is idempotent by construction.
 */
import 'dotenv/config';
import { db } from '../client';
import { importRecords } from './index';

async function main(): Promise<void> {
  const summary = await importRecords(db());

  const lines = Object.entries(summary).map(([key, value]) => `  ${key.padEnd(28)} ${value}`);
  console.log('Imported:\n' + lines.join('\n'));

  if (summary.mediaSkippedForMissingAlt > 0) {
    console.log(
      `\nNote: ${summary.mediaSkippedForMissingAlt} image(s) in the record carry no alt text ` +
        `and were not imported into \`media\`. They remain in git and are still rendered by the ` +
        `site's image registry. Write alt text for them before Phase 4 moves assets to R2.`,
    );
  }
}

main().catch((error: unknown) => {
  console.error('\nImport failed. Nothing was left half-written that a re-run will not repair.\n');
  console.error(error);
  process.exit(1);
});
