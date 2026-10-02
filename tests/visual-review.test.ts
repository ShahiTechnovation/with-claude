import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs dev script, no types.
import { parseHeaders, strictFailures } from '../scripts/dev/visual-review.mjs';

/**
 * The preview smoke check is a merge gate, so what it fails on is pinned here.
 * It fails on what a visitor would hit; it does not fail on console noise,
 * which on a preview is mostly third parties.
 */
const ok = { status: 200, overflowX: false, mains: 1, h1s: 1, pageErrors: 0, errors: [] as string[] };

describe('STRICT mode of the visual review', () => {
  it('passes a healthy page, even a noisy one', () => {
    expect(strictFailures(ok)).toEqual([]);
    expect(strictFailures({ ...ok, errors: ['Failed to load resource: analytics.js'] })).toEqual([]);
  });

  it('fails on each thing a visitor would hit', () => {
    expect(strictFailures({ ...ok, status: 500 })).toEqual(['status 500']);
    expect(strictFailures({ ...ok, status: null })).toEqual(['status null']);
    expect(strictFailures({ ...ok, overflowX: true })).toEqual(['HORIZONTAL OVERFLOW']);
    expect(strictFailures({ ...ok, mains: 0 })).toEqual(['0 <main>']);
    expect(strictFailures({ ...ok, h1s: 2 })).toEqual(['2 <h1>']);
    expect(strictFailures({ ...ok, pageErrors: 1 })).toEqual(['1 uncaught page error(s)']);
  });
});

describe('EXTRA_HEADERS', () => {
  it('reads one "name: value" per line and drops a header with no value', () => {
    expect(parseHeaders('x-vercel-protection-bypass: s3cret\nx-other:  a:b ')).toEqual({
      'x-vercel-protection-bypass': 's3cret',
      'x-other': 'a:b',
    });
    // An unset secret arrives as an empty value; no header is sent for it.
    expect(parseHeaders('x-vercel-protection-bypass: ')).toEqual({});
    expect(parseHeaders(undefined)).toEqual({});
  });
});
