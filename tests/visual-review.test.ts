import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHeaders, scopeHeaders, strictFailures } from '../scripts/dev/visual-review.mjs';

const workflow = readFileSync('.github/workflows/preview-smoke.yml', 'utf8').replace(/\r\n/g, '\n');

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

  /**
   * The workflow's EXTRA_HEADERS, as GitHub renders it with and without the
   * secret. Nothing Vercel-specific leaves the runner unless the secret is set.
   */
  it('send nothing from the preview workflow when the bypass secret is unset', () => {
    const block = workflow.match(/EXTRA_HEADERS: \|-\n((?: {12}\S.*\n)+)/)?.[1] ?? '';
    const render = (secret: string) =>
      block
        .replace(/^ {12}/gm, '')
        .replaceAll("${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET != '' && 'true' || '' }}", secret ? 'true' : '')
        .replaceAll('${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}', secret);

    expect(block).not.toBe('');
    expect(render('')).not.toContain('${{');
    expect(parseHeaders(render(''))).toEqual({});
    expect(parseHeaders(render('s3cret'))).toEqual({
      'x-vercel-protection-bypass': 's3cret',
      'x-vercel-set-bypass-cookie': 'true',
    });
  });

  it("go to BASE's origin only, and never along a redirect", async () => {
    let matches!: (url: URL) => boolean;
    let handle!: (route: unknown) => Promise<void>;
    const context = {
      route: async (m: typeof matches, h: typeof handle) => {
        matches = m;
        handle = h;
      },
    };
    await scopeHeaders(context, ORIGIN, { 'x-vercel-protection-bypass': 's3cret' });

    expect(matches(new URL(`${ORIGIN}/_astro/app.js`))).toBe(true);
    expect(matches(new URL('https://fonts.gstatic.com/s/inter.woff2'))).toBe(false);
    expect(matches(new URL('https://vercel.com/login'))).toBe(false);

    // Fetched with redirects off and handed to the browser as it came: the
    // browser follows a redirect itself, and that request goes out without
    // the headers. `route.continue({ headers })` would carry them across.
    const calls: unknown[] = [];
    const redirect = { status: () => 302 };
    await handle({
      request: () => ({ headers: () => ({ accept: 'text/html' }) }),
      fetch: async (options: unknown) => {
        calls.push(['fetch', options]);
        return redirect;
      },
      fulfill: async (options: unknown) => {
        calls.push(['fulfill', options]);
      },
      continue: async (options: unknown) => {
        calls.push(['continue', options]);
      },
      abort: async () => {
        calls.push(['abort']);
      },
    });
    expect(calls).toEqual([
      ['fetch', { headers: { accept: 'text/html', 'x-vercel-protection-bypass': 's3cret' }, maxRedirects: 0 }],
      ['fulfill', { response: redirect }],
    ]);
  });
});

describe('the preview workflow', () => {
  /**
   * The smoke job is filtered on two guessed strings. A wrong guess skips it
   * without a trace, so a job with no filter and no secrets prints what Vercel
   * actually sent.
   */
  it('shows the payload on every dispatch, without secrets or interpolated shell', () => {
    const job = workflow.match(/\n  payload:\n([\s\S]*?)\n  smoke:\n/)?.[1] ?? '';
    expect(job).not.toBe('');
    expect(job).not.toMatch(/^\s+if:/m);
    expect(job).not.toContain('secrets.');
    expect(job).toContain('permissions: {}');
    for (const field of ['client_payload.environment', 'client_payload.project.name', 'client_payload.url']) {
      expect(job, field).toContain(`\${{ github.event.${field} }}`);
    }
    // Payload values reach the shell as environment variables only.
    const run = job.slice(job.indexOf('run: |'));
    expect(run).not.toBe('');
    expect(run).not.toContain('${{');
  });

  it("cites where the payload's fields are defined", () => {
    expect(workflow).toContain('packages/repository-dispatch/src/data/common.ts');
    expect(workflow).toContain('data/deployment.ts');
  });
});
