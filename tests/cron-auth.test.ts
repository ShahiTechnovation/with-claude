import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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
