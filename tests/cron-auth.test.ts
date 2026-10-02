import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as health } from '../src/pages/api/health';

describe('the cron secret', () => {
  it('is compared in constant time by every cron route', () => {
    const routes = readdirSync('src/pages/api/cron').map((file) => `src/pages/api/cron/${file}`);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const route of routes) {
      const source = readFileSync(route, 'utf8');
      expect(source, route).toContain('secretMatches(');
      expect(source, route).not.toMatch(/[!=]==?\s*`Bearer /);
    }
  });
});

describe('/api/health', () => {
  const call = (headers: Record<string, string> = {}) =>
    health({ request: new Request('https://www.withclaude.in/api/health/', { headers }) } as never) as Promise<Response>;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('tells the public only that it is up, without reaching for the database', async () => {
    // No database is configured, so a 200 means nothing was checked.
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('CRON_SECRET', 'cron-secret-for-tests');
    const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: 'cron-secret-for-tests' }];
    for (const headers of attempts) {
      const response = await call(headers);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    // An unset secret is a refusal, never a match for "Bearer undefined".
    vi.stubEnv('CRON_SECRET', '');
    expect(await (await call({ authorization: 'Bearer undefined' })).json()).toEqual({ ok: true });
  });

  it('gives the details to the cron bearer', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('CRON_SECRET', 'cron-secret-for-tests');
    const response = await call({ authorization: 'Bearer cron-secret-for-tests' });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, configured: { database: false, cron: true }, database: { reachable: false } });
    expect(body.events).toHaveProperty('mode');
  });
});
