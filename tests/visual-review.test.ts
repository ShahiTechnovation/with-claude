import { describe, expect, it } from 'vitest';
import { parseHeaders, strictFailures } from '../scripts/dev/visual-review.mjs';

/**
 * The preview smoke check is a merge gate, so what it fails on is pinned here.
 * It fails on what a visitor would hit; it does not fail on console noise,
 * which on a preview is mostly third parties.
 */
const ORIGIN = 'https://with-claude-abc123-team.vercel.app';
const ok = { status: 200, url: `${ORIGIN}/events/`, overflowX: false, mains: 1, h1s: 1, pageErrors: 0, errors: [] as string[] };

describe('STRICT mode of the visual review', () => {
  it('passes a healthy page, even a noisy one', () => {
    expect(strictFailures(ok, ORIGIN)).toEqual([]);
    expect(strictFailures({ ...ok, errors: ['Failed to load resource: analytics.js'] }, ORIGIN)).toEqual([]);
  });

  it('fails on each thing a visitor would hit', () => {
    expect(strictFailures({ ...ok, status: 500 }, ORIGIN)).toEqual(['status 500']);
    expect(strictFailures({ ...ok, status: null }, ORIGIN)).toEqual(['status null']);
    expect(strictFailures({ ...ok, overflowX: true }, ORIGIN)).toEqual(['HORIZONTAL OVERFLOW']);
    expect(strictFailures({ ...ok, mains: 0 }, ORIGIN)).toEqual(['0 <main>']);
    expect(strictFailures({ ...ok, h1s: 2 }, ORIGIN)).toEqual(['2 <h1>']);
    expect(strictFailures({ ...ok, pageErrors: 1 }, ORIGIN)).toEqual(['1 uncaught page error(s)']);
  });

  it('fails a page that ended on another origin, however healthy it looks', () => {
    // What a protected preview shows a run that could not get past it:
    // Vercel's login, at 200, with one <main> and one <h1>.
    const login = 'https://vercel.com/login?next=%2Fsso-api';
    expect(strictFailures({ ...ok, url: login }, ORIGIN)).toEqual([`ended on ${login}`]);
    // A redirect within the preview is fine.
    expect(strictFailures({ ...ok, url: `${ORIGIN}/events/?page=2` }, ORIGIN)).toEqual([]);
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
