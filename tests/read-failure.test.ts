import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { requireAsset } from '../src/lib/images';
import { classifyReadFailure } from '../src/server/public/read-failure';

describe('classifyReadFailure', () => {
  it('names a database that is behind the code (missing column/table), however the driver wraps it', () => {
    const pg = Object.assign(new Error('column events.short_title does not exist'), {
      code: '42703',
    });
    const drizzle = Object.assign(new Error('Failed query: select …'), { cause: pg });
    expect(classifyReadFailure(drizzle)).toBe('schema-behind');
    expect(classifyReadFailure(new Error('relation "project_credits" does not exist'))).toBe(
      'schema-behind',
    );
    expect(classifyReadFailure(Object.assign(new Error('x'), { code: '42P01' }))).toBe(
      'schema-behind',
    );
  });

  it('names a photograph the database lists and the bundle has no file for', () => {
    expect(
      classifyReadFailure(
        new Error('Unknown image "events/x.jpg". Expected a file at src/assets/events/x.jpg.'),
      ),
    ).toBe('asset-missing');
    // What `requireAsset` really throws, alone or as a cause, so a reworded message fails here.
    const thrown = (() => {
      try {
        requireAsset('events/not-on-disk.jpg');
      } catch (error) {
        return error;
      }
    })();
    expect(classifyReadFailure(thrown)).toBe('asset-missing');
    expect(classifyReadFailure(Object.assign(new Error('render failed'), { cause: thrown }))).toBe(
      'asset-missing',
    );
  });

  it('everything else is simply unavailable', () => {
    expect(classifyReadFailure(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(
      'unavailable',
    );
    expect(classifyReadFailure(Object.assign(new Error('timeout'), { code: '57014' }))).toBe(
      'unavailable',
    );
    expect(classifyReadFailure(null)).toBe('unavailable');
  });
});

// Whitespace-normalised, so a prettier wrap does not break the pins.
const source = (path: string) => readFileSync(path, 'utf8').replace(/\s+/g, ' ');

describe('the pages that meet a photograph with no file', () => {
  it('/gallery/ sends no Retry-After for it, and says what to do in development', () => {
    const page = source('src/pages/gallery.astro');
    expect(page).toContain(
      "if (failure !== 'asset-missing') Astro.response.headers.set('Retry-After', '30');",
    );
    expect(page).toContain("{devHint === 'asset-missing' && (");
    expect(page).toContain('<code>npm run backfill:photos -- rollback</code> with its receipt');
  });

  it.each(['src/components/home/PhotoStrip.astro', 'src/pages/index.astro'])(
    '%s leaves the photo out and logs its path and event',
    (file) => {
      expect(source(file)).toMatch(
        /console\.error\( ?`\[home\] photo \$\{p\.src\} from \$\{(p\.)?event\.slug\} is in the database but not in src\/assets;/,
      );
    },
  );
});
