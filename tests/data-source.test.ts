/**
 * THE SOURCE SWITCH ITSELF.
 *
 * `tests/equivalence.test.ts` proves the two sources produce the same records.
 * This proves the machinery that chooses between them behaves — that the
 * default is safe, that a `DATA_SOURCE=db` build cannot silently degrade to
 * the TypeScript record, and that the credential the public build reads with
 * is the one it should be.
 *
 * These are the properties the rollback rests on. If the default ever stops
 * being `ts`, or a missing snapshot ever stops being an error, somebody will
 * ship a build believing it came from a database when it did not.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataSourceName } from '../src/data/source';
import { readUrl } from '../db/snapshot';
import { SNAPSHOT_VERSION, type Snapshot } from '../src/data/dataset';

describe('choosing a source', () => {
  it('defaults to the TypeScript record', () => {
    // THE ROLLBACK. An unset variable must never reach a database.
    expect(dataSourceName({})).toBe('ts');
    expect(dataSourceName({ DATA_SOURCE: undefined })).toBe('ts');
    expect(dataSourceName({ DATA_SOURCE: '' })).toBe('ts');
    expect(dataSourceName({ DATA_SOURCE: '   ' })).toBe('ts');
  });

  it('accepts the two names, case-insensitively', () => {
    expect(dataSourceName({ DATA_SOURCE: 'ts' })).toBe('ts');
    expect(dataSourceName({ DATA_SOURCE: 'TS' })).toBe('ts');
    expect(dataSourceName({ DATA_SOURCE: 'db' })).toBe('db');
    expect(dataSourceName({ DATA_SOURCE: 'DB' })).toBe('db');
  });

  it('refuses anything else instead of guessing', () => {
    /**
     * A typo must be loud. `DATA_SOURCE=database` quietly building from
     * TypeScript is how somebody comes to believe they verified the database
     * path having verified nothing at all.
     */
    for (const value of ['database', 'postgres', 'sql', 'neon', 'true', 'yes']) {
      expect(() => dataSourceName({ DATA_SOURCE: value }), value).toThrow(/not a data source/);
    }
  });
});

describe('the snapshot', () => {
  const made: string[] = [];

  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.SNAPSHOT_DIR;
    delete process.env.DATA_SOURCE;
  });

  /** A scratch snapshot directory, and a fresh copy of the dataset module. */
  async function withSnapshot(contents: unknown | undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'wc-snapshot-'));
    made.push(dir);
    mkdirSync(dir, { recursive: true });
    if (contents !== undefined) {
      writeFileSync(join(dir, 'dataset.json'), JSON.stringify(contents), 'utf8');
    }
    process.env.SNAPSHOT_DIR = dir;
    process.env.DATA_SOURCE = 'db';

    /**
     * A FRESH MODULE INSTANCE.
     *
     * `dataset.ts` memoizes its record set for the life of the process, which
     * is exactly right for a build and inconvenient here — a second test would
     * otherwise get the first one's answer. `resetModules()` clears the module
     * registry so the import below re-evaluates it, including re-reading
     * `SNAPSHOT_DIR`.
     */
    vi.resetModules();
    return import('../src/data/dataset');
  }

  it('fails loudly when DATA_SOURCE=db and no snapshot was taken', async () => {
    /**
     * THE MOST IMPORTANT ASSERTION IN THIS FILE.
     *
     * A missing snapshot must never fall back to `src/data/*.ts`. A build that
     * reported success having quietly rendered the wrong source is worse than
     * a build that failed, because nobody would go looking.
     */
    const mod = await withSnapshot(undefined);
    expect(() => mod.records()).toThrow(/no dataset snapshot/i);
    // And the message says how to fix it.
    expect(() => mod.records()).toThrow(/prebuild|DATA_SOURCE=ts/);
  });

  it('refuses a snapshot taken from the other source', async () => {
    const mod = await withSnapshot({
      version: SNAPSHOT_VERSION,
      source: 'ts',
      generatedAt: new Date().toISOString(),
      records: { ambassadors: [], builders: [], cities: [], events: [], guides: [], projects: [], stories: [], useCases: [] },
    } satisfies Snapshot);

    expect(() => mod.records()).toThrow(/taken from "ts"/);
  });

  it('refuses a snapshot from an older shape', async () => {
    const mod = await withSnapshot({
      version: 99,
      source: 'db',
      generatedAt: new Date().toISOString(),
      records: {},
    });

    expect(() => mod.records()).toThrow(/version 99/);
  });

  it('reads a valid snapshot, once', async () => {
    const records = {
      ambassadors: [],
      builders: [],
      cities: [{ id: 'c1', slug: 'bhopal', status: 'published', name: 'Bhopal' }],
      events: [],
      guides: [],
      projects: [],
      stories: [],
      useCases: [],
    };
    const mod = await withSnapshot({
      version: SNAPSHOT_VERSION,
      source: 'db',
      generatedAt: new Date().toISOString(),
      records,
    });

    const first = mod.records();
    const second = mod.records();

    expect(first.cities).toHaveLength(1);
    // Memoized: a build renders ~90 pages off one load, not ninety loads.
    expect(second).toBe(first);
  });
});

describe('the credential the public build reads with', () => {
  it('prefers a read-only role', () => {
    // §25. A build only needs SELECT, so it should run as a role that can only
    // SELECT — a build cannot corrupt what it cannot write.
    expect(
      readUrl({
        DATABASE_URL_READONLY: 'postgres://reader@host/db',
        DATABASE_URL: 'postgres://writer@host/db',
      } as NodeJS.ProcessEnv),
    ).toBe('postgres://reader@host/db');
  });

  it('falls back to the write credential rather than failing', () => {
    // Working beats pure. The warning is the nudge; a broken build is not.
    expect(readUrl({ DATABASE_URL: 'postgres://writer@host/db' } as NodeJS.ProcessEnv)).toBe(
      'postgres://writer@host/db',
    );
  });

  it('says what to do when neither is set', () => {
    expect(() => readUrl({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL_READONLY/);
    expect(() => readUrl({} as NodeJS.ProcessEnv)).toThrow(/DATA_SOURCE=ts/);
  });

  it('refuses to start if a credential was exposed through PUBLIC_', () => {
    /**
     * Astro inlines anything `PUBLIC_`-prefixed into the browser bundle, so a
     * `PUBLIC_DATABASE_URL` would ship the connection string to every visitor.
     * The check refuses rather than trusting nobody will ever add one.
     */
    expect(() =>
      readUrl({
        DATABASE_URL: 'postgres://writer@host/db',
        PUBLIC_DATABASE_URL: 'postgres://leaked@host/db',
      } as NodeJS.ProcessEnv),
    ).toThrow(/PUBLIC_/);
  });
});
