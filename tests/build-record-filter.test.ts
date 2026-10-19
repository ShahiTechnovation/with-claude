/**
 * The build-time record passes the same single-host filter as the live one.
 *
 * `/record/` and `/events/claude-community/` are prerendered from `records()`.
 * Before this filter lived there, a `DATA_SOURCE=db` build listed events that
 * `loadLiveRecords()` withholds, and each of them linked to a 404.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SNAPSHOT_VERSION, type Snapshot } from '../src/data/dataset';
import { events as curated } from '../src/data/events';

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.SNAPSHOT_DIR;
  delete process.env.DATA_SOURCE;
});

/** A fresh `dataset.ts`, so its memoized record is read again. */
async function freshDataset() {
  vi.resetModules();
  return import('../src/data/dataset');
}

describe('records() applies the single-host filter', () => {
  it('drops a host-less event from a DATA_SOURCE=db snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-build-record-'));
    made.push(dir);
    const base = { title: 'x', format: 'meetup', citySlug: 'bhopal', status: 'published' };
    writeFileSync(
      join(dir, 'dataset.json'),
      JSON.stringify({
        version: SNAPSHOT_VERSION,
        source: 'db',
        generatedAt: new Date().toISOString(),
        records: {
          ambassadors: [],
          builders: [],
          cities: [],
          events: [
            { ...base, slug: 'hosted-by-aniket', host: { ambassadorSlug: 'aniket-sahu' } },
            { ...base, slug: 'hosted-by-nobody' },
          ],
          guides: [],
          projects: [],
          stories: [],
          useCases: [],
        },
      } as unknown as Snapshot),
      'utf8',
    );
    process.env.SNAPSHOT_DIR = dir;
    process.env.DATA_SOURCE = 'db';

    const { records } = await freshDataset();

    expect(records().events.map((e) => e.slug)).toEqual(['hosted-by-aniket']);
  });

  it('keeps every curated event on the TypeScript path', async () => {
    process.env.DATA_SOURCE = 'ts';

    const { records } = await freshDataset();

    expect(records().events.map((e) => e.slug)).toEqual(curated.map((e) => e.slug));
    expect(curated.length).toBeGreaterThanOrEqual(17);
  });
});
