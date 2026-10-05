/**
 * What `apply` says and writes once the transaction has committed.
 *
 * This lives outside `cli.ts` for two reasons. It is the only part of the
 * backfill with no second chance — everything before the COMMIT aborts
 * cleanly, and from the COMMIT onward 35 + 35 rows exist and the receipt is
 * the only record of how to remove them. And `cli.ts` runs its command at
 * import time, so a test cannot reach a function that lives there; the one
 * path worth testing against a failing disk has to be importable.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackfillReceipt } from './event-photos';

/** Everything `emitReceipt` touches outside its own arguments, so a test can fail it. */
export interface ReceiptSink {
  log: (message: string) => void;
  error: (message: string) => void;
  mkdir: (dir: string) => Promise<unknown>;
  writeFile: (path: string, body: string) => Promise<unknown>;
}

const processSink: ReceiptSink = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  mkdir: (dir) => mkdir(dir, { recursive: true }),
  writeFile: (path, body) => writeFile(path, body),
};

/** `imports/` is git-ignored; the timestamp is the receipt's own `appliedAt`. */
export function receiptPath(receipt: BackfillReceipt): string {
  return join('imports', `backfill-event-photos-${receipt.appliedAt.replace(/[:.]/g, '-')}.json`);
}

/**
 * Report a committed backfill, then try to persist its receipt.
 *
 * The order is the whole point. The transaction has already committed when
 * this is called, so nothing may throw before the undo reaches stdout. Writing
 * the file first — as this did until [VIS-17] — means a read-only cwd, a full
 * disk, or `imports` existing as a file takes the printed SQL down with the
 * receipt, and a fresh `plan` cannot recover it: with the inserts applied
 * there is nothing left to insert, so the planner prints "nothing to undo" and
 * the undo has to be hand-written from the paths in `src/data/events.ts`.
 *
 * So: print, then write, and degrade to stdout if the write fails.
 *
 * Returns the exit code the CLI should use — 0 when the receipt is on disk, 3
 * when only the scrollback has it, which is a successful write the operator
 * has to go and save by hand.
 */
export async function emitReceipt(receipt: BackfillReceipt, sink: ReceiptSink = processSink): Promise<0 | 3> {
  sink.log(
    `Applied: media +${receipt.insertedMedia.length}, event_photos +${receipt.insertedPhotos.length}, ` +
      `${receipt.dimensionsUpdated.length} existing media rows given width/height.`,
  );
  sink.log('\nTo undo, as SQL:\n');
  sink.log(receipt.rollbackSql);

  const path = receiptPath(receipt);
  try {
    await sink.mkdir('imports');
    await sink.writeFile(path, JSON.stringify(receipt, null, 2));
  } catch (error) {
    sink.error(`\nThe backfill COMMITTED, but its receipt could not be written to ${path}:`);
    sink.error(`  ${error instanceof Error ? error.message : String(error)}`);
    sink.error(
      'The rows are in. The SQL above is the undo — copy it now. To use the `rollback` command ' +
        `instead, save the JSON below to ${path} and run:\n` +
        `  npm run backfill:photos -- rollback --receipt ${path} --yes\n`,
    );
    sink.error(JSON.stringify(receipt, null, 2));
    return 3;
  }

  sink.log(`\nReceipt: ${path}`);
  sink.log(`Preferred undo:\n  npm run backfill:photos -- rollback --receipt ${path} --yes\n`);
  return 0;
}
