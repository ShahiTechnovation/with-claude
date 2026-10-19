/**
 * MIGRATION STRICT — tests that the migration harness surfaces duplicates.
 *
 * This test ensures that the migration chain is clean and does not contain
 * duplicate schema objects (like the ones historically found in 0013).
 *
 * It also checks the journal. Drizzle applies a migration only when its `when`
 * is later than the last one applied, so an entry out of order is skipped on a
 * real database without an error. A test database starts empty and applies
 * everything, so only this check can see it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createStrictTestDatabase } from '../db/testing';

describe('Phase D: new migrations must not duplicate existing schema objects', () => {
  it('createStrictTestDatabase() succeeds because the migration chain is clean', async () => {
    const db = await createStrictTestDatabase();
    await db.$close();
  });

  it('the journal is in order and names every migration file', () => {
    const { entries } = JSON.parse(readFileSync('db/migrations/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      if (i) expect(e.when).toBeGreaterThan(entries[i - 1]!.when);
    });
    const files = readdirSync('db/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(entries.map((e) => `${e.tag}.sql`)).toEqual(files);
  });
});
