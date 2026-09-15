/**
 * MIGRATION STRICT — tests that the migration harness surfaces duplicates.
 *
 * This test ensures that the migration chain is clean and does not contain
 * duplicate schema objects (like the ones historically found in 0013).
 */
import { describe, expect, it } from 'vitest';
import { createStrictTestDatabase } from '../db/testing';

describe('Phase D: new migrations must not duplicate existing schema objects', () => {
  it('createStrictTestDatabase() succeeds because the migration chain is clean', async () => {
    const db = await createStrictTestDatabase();
    await db.$close();
  });
});
