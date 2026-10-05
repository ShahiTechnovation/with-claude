/**
 * The admin refuses the Vercel adapter's path override too (GHSA-mr6q-rp88-fx84).
 *
 * The public site got its guard in `src/server/vercel-entrypoint.ts`. The admin
 * is a second Vercel project on the same adapter, and it was left on the
 * adapter's own entry: any caller could still pick which admin route rendered,
 * with the `x-astro-path` header or the `x_astro_path` query parameter. The
 * session gate runs on the swapped path, so this was not a way past sign-in,
 * but the swap also moves the host Astro's own origin check compares against.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ resolveSession: vi.fn() }));
vi.mock('astro:middleware', () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock('../admin/src/server/session', () => ({ resolveSession: session.resolveSession }));

import { onRequest } from '../admin/src/middleware';

type Handler = (context: unknown, next: () => Promise<Response>) => Promise<Response>;

function context(url: string, headers: Record<string, string> = {}) {
  return {
    url: new URL(url),
    request: new Request(url, { headers }),
    locals: {} as Record<string, unknown>,
    redirect: (to: string, status: number) => new Response(null, { status, headers: { Location: to } }),
  };
}

describe('the admin middleware', () => {
  beforeEach(() => {
    session.resolveSession.mockReset();
    session.resolveSession.mockResolvedValue({ authenticated: false, reason: 'no-session' });
  });

  it('refuses the x-astro-path header before it looks at the session', async () => {
    const next = vi.fn();
    const response = await (onRequest as unknown as Handler)(
      context('https://admin.withclaude.in/login', { 'x-astro-path': '/submissions' }),
      next,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(session.resolveSession).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('still gates an ordinary request on the session', async () => {
    const next = vi.fn();
    const response = await (onRequest as unknown as Handler)(context('https://admin.withclaude.in/submissions'), next);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login?next=%2Fsubmissions');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('the admin function entry', () => {
  const config = readFileSync('admin/astro.config.mjs', 'utf8').replace(/\r\n/g, '\n');

  it("is the public site's guarded entry, not a second copy of it", () => {
    // The same exact-match alias the public config uses, pointed at the one wrapper.
    expect(config).toMatch(/find: \/\^@astrojs\\\/vercel\\\/entrypoint\$\/,\s*replacement: fileURLToPath\(new URL\('\.\.\/src\/server\/vercel-entrypoint\.ts', import\.meta\.url\)\)/);
    expect(existsSync('src/server/vercel-entrypoint.ts')).toBe(true);
    expect(existsSync('admin/src/server/vercel-entrypoint.ts')).toBe(false);
  });

  // CI does not build the admin, so this cannot fail there. It checks a local
  // or Vercel build when one exists: the wrapper's name is in the function.
  it.skipIf(!['admin/.vercel/output/functions/_render.func', 'admin/dist/server'].some(existsSync))(
    'is what an admin build is made from',
    () => {
      const roots = ['admin/.vercel/output/functions/_render.func', 'admin/dist/server'].filter(existsSync);
      const built = roots.flatMap((root) =>
        readdirSync(root, { recursive: true, encoding: 'utf8' })
          .filter((file) => file.endsWith('.mjs') && !file.split(/[\\/]/).includes('node_modules'))
          .map((file) => readFileSync(join(root, file), 'utf8')),
      );
      expect(built.some((code) => code.includes('refusePathOverride'))).toBe(true);
    },
  );
});
