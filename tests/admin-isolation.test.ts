import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The wall between the two applications.
 *
 * Phase 2 added authentication to this repository. The claim that must survive
 * it is that `withclaude.in` is still a static site with no session, no auth
 * library and no database credential — and the only way to hold that claim is
 * to check the artifacts, not the intentions.
 *
 * Everything here reads files: the public site's source, its built bundle, and
 * the admin's source. If any of these fail, the separation has been broken
 * somewhere a code review would probably have missed.
 */

function filesUnder(dir: string, extensions: string[]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.astro') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const PUBLIC_SOURCE = filesUnder('src', ['.ts', '.astro', '.js', '.mjs']);

/** Whichever build output is on disk. */
function publicClientDir(): string | undefined {
  for (const dir of ['dist/client', '.vercel/output/static', 'dist']) {
    try {
      if (statSync(dir).isDirectory()) {
        if (dir === 'dist' && existsSync('dist/client')) continue;
        return dir;
      }
    } catch {
      /* not built */
    }
  }
  return undefined;
}

// ── The public site has no authentication ───────────────────────────────

describe('the public site has no authentication', () => {
  it('imports no auth library anywhere in its source', () => {
    expect(PUBLIC_SOURCE.length).toBeGreaterThan(50);

    for (const file of PUBLIC_SOURCE) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} imports better-auth`).not.toMatch(/better-auth/);
      expect(text, `${file} imports Auth.js`).not.toMatch(/@auth\/core|auth-astro|next-auth/);
    }
  });

  it('declares no auth dependency in its package manifest', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    for (const name of Object.keys(deps)) {
      expect(name, 'the root package must not depend on an auth library').not.toMatch(
        /better-auth|next-auth|^@auth\//,
      );
    }

    // The admin declares it, and only the admin.
    const adminPkg = JSON.parse(readFileSync('admin/package.json', 'utf8'));
    expect(Object.keys(adminPkg.dependencies)).toContain('better-auth');
  });

  it('reads no session and sets no cookie', () => {
    for (const file of PUBLIC_SOURCE) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} touches cookies`).not.toMatch(
        /Astro\.cookies|context\.cookies|set-cookie|getSession|resolveSession/i,
      );
    }
  });

  it('has no login, logout or admin route', () => {
    const routes = filesUnder('src/pages', ['.astro', '.ts']).map((f) => f.replace(/\\/g, '/'));

    for (const route of routes) {
      expect(route).not.toMatch(/\/(login|logout|admin|signin|sign-in|session)/i);
    }
  });

  it('has no middleware, so nothing intercepts a public request', () => {
    // The admin has `src/middleware.ts`. The public site must not — every one
    // of its 71 pages is a file, and a file cannot be gated.
    expect(existsSync('src/middleware.ts')).toBe(false);
    expect(existsSync('src/middleware/index.ts')).toBe(false);
  });

  it('stays static, with only the two Phase 1 API routes rendered on demand', () => {
    const dynamic = filesUnder('src/pages', ['.astro', '.ts'])
      .filter((file) => /export\s+const\s+prerender\s*=\s*false/.test(readFileSync(file, 'utf8')))
      .map((f) => f.replace(/\\/g, '/'))
      .sort();

    expect(dynamic).toEqual(['src/pages/api/cron/rebuild.ts', 'src/pages/api/submit.ts']);
  });

  it('never imports the pooled database client', () => {
    // `db/pool.ts` opens a WebSocket connection for the admin's transactions.
    // The public site uses `db/client.ts` and has no business with the other.
    for (const file of PUBLIC_SOURCE) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} imports db/pool`).not.toMatch(/db\/pool|pooledDb/);
    }
  });
});

// ── The public bundle ───────────────────────────────────────────────────

describe('the public browser bundle', () => {
  it('carries no auth code, session reference or credential', () => {
    const dir = publicClientDir();
    // Fail rather than skip. This is the assertion most worth having, and a
    // quiet skip is how it stops running without anybody noticing.
    expect(dir, 'run `npm run build` before the isolation tests').toBeDefined();

    const files = filesUnder(dir!, ['.js', '.html', '.css', '.json', '.xml', '.txt']);
    expect(files.length).toBeGreaterThan(0);

    const forbidden: [RegExp, string][] = [
      [/better-auth/i, 'the auth library'],
      [/next-auth|@auth\/core/i, 'an auth library'],
      [/BETTER_AUTH_SECRET|BETTER_AUTH_URL/, 'an auth environment variable'],
      [/postgres(ql)?:\/\//i, 'a connection string'],
      [/\bneon\.tech\b/i, 'a Neon host'],
      [/DATABASE_URL/, 'the database variable name'],
      [/\bre_[A-Za-z0-9]{16,}/, 'a Resend key'],
      [/admin\.withclaude\.in/i, 'a link to the admin'],
      [/magic-link|magicLink/, 'the magic-link flow'],
    ];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, description] of forbidden) {
        expect(pattern.test(text), `${file} contains ${description}`).toBe(false);
      }
    }
  });

  it('contains no admin route in its output', () => {
    const dir = publicClientDir();
    expect(dir).toBeDefined();

    const paths = filesUnder(dir!, ['.html']).map((f) => f.replace(/\\/g, '/'));
    expect(paths.length).toBeGreaterThan(60);

    for (const path of paths) {
      expect(path).not.toMatch(/\/(login|logout|admin|audit|submissions)\//);
    }
  });
});

// ── The admin is the mirror image ───────────────────────────────────────

describe('the admin is server-rendered and separate', () => {
  it('runs with SSR, not static output', () => {
    const config = readFileSync('admin/astro.config.mjs', 'utf8');
    expect(config).toMatch(/output:\s*'server'/);
  });

  it('gates every route through one middleware', () => {
    expect(existsSync('admin/src/middleware.ts')).toBe(true);
    const middleware = readFileSync('admin/src/middleware.ts', 'utf8');

    // Private by default: only an explicit list is reachable without a session.
    expect(middleware).toMatch(/PUBLIC_PATHS/);
    expect(middleware).toMatch(/resolveSession/);
    expect(middleware).toMatch(/status:\s*401/);
    expect(middleware).toMatch(/redirect\(`\/login/);
  });

  it('exposes only login and the auth handler without a session', () => {
    const middleware = readFileSync('admin/src/middleware.ts', 'utf8');
    const list = /const PUBLIC_PATHS = \[([^\]]*)\]/.exec(middleware)?.[1] ?? '';
    const paths = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    expect(paths).toEqual(['/api/auth', '/api/login', '/login']);
  });

  it('checks the session again inside its state-changing route', () => {
    // Belt and braces: a route that trusts middleware it cannot see is one
    // refactor away from being open.
    const review = readFileSync('admin/src/pages/api/submissions/[id]/review.ts', 'utf8');
    expect(review).toMatch(/locals\.user/);
    expect(review).toMatch(/status:\s*401/);
    expect(review).toMatch(/assertSameOrigin/);
  });

  it('routes every mutation through the transition layer', () => {
    // No route may write `submissions.status` itself. If one ever does, the
    // audit log stops being a complete account of what happened.
    const routes = filesUnder('admin/src/pages', ['.astro', '.ts']);

    for (const file of routes) {
      const text = readFileSync(file, 'utf8');
      const writesStatus = /\.update\(\s*schema\.submissions|update\(submissions\)/.test(text);
      expect(writesStatus, `${file} writes submissions directly`).toBe(false);
    }

    const review = readFileSync('admin/src/pages/api/submissions/[id]/review.ts', 'utf8');
    expect(review).toMatch(/transitionSubmission/);
  });

  it('prerenders nothing', () => {
    const pages = filesUnder('admin/src/pages', ['.astro', '.ts']);
    expect(pages.length).toBeGreaterThan(4);

    for (const file of pages) {
      const text = readFileSync(file, 'utf8');
      // Every route either opts out explicitly or is covered by
      // `output: 'server'`, which prerenders nothing by default.
      expect(text, `${file} opts into prerendering`).not.toMatch(
        /export\s+const\s+prerender\s*=\s*true/,
      );
    }
  });

  it('tells crawlers to stay out', () => {
    const robots = readFileSync('admin/public/robots.txt', 'utf8');
    expect(robots).toMatch(/Disallow:\s*\//);

    const layout = readFileSync('admin/src/layouts/Admin.astro', 'utf8');
    expect(layout).toMatch(/noindex/);
  });
});

// ── No Phase 3 or Phase 4 work has crept in ─────────────────────────────

describe('nothing from a later phase has crept in', () => {
  const allSource = [
    ...PUBLIC_SOURCE,
    ...filesUnder('admin/src', ['.ts', '.astro']),
    ...filesUnder('db', ['.ts']),
  ];

  it('implements no media storage', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const adminPkg = JSON.parse(readFileSync('admin/package.json', 'utf8'));
    const deps = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...adminPkg.dependencies,
    });

    // Vercel Blob is the planned Phase 4 store. It is not installed, because
    // installing a dependency for a phase that has not started is how a phase
    // boundary stops meaning anything.
    expect(deps).not.toContain('@vercel/blob');
    for (const name of deps) {
      expect(name).not.toMatch(/aws-sdk|@aws-sdk|r2|cloudflare/i);
    }

    for (const file of allSource) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} references Blob uploads`).not.toMatch(
        /@vercel\/blob|presigned|putBlob|uploadUrl/i,
      );
    }

    expect(existsSync('admin/src/pages/media.astro')).toBe(false);
    expect(existsSync('admin/src/pages/api/media')).toBe(false);
  });

  /**
   * Phase 3 gave the admin a publish flow. What must remain true is that it is
   * the ONLY way to publish, and that it cannot be reached from the review
   * queue — the two lifecycles stay separate.
   */
  it('confines the deploy trigger to the content state machine', () => {
    const adminSource = filesUnder('admin/src', ['.ts', '.astro']);

    /** The one module allowed to call a deploy hook. */
    const PUBLISHING = join('admin', 'src', 'server', 'publishing.ts');

    for (const file of adminSource) {
      if (file === PUBLISHING) continue;
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} triggers a deployment of its own`).not.toMatch(
        /VERCEL_DEPLOY_HOOK_URL/,
      );
    }

    // And the admin never decides which source the PUBLIC build reads. That is
    // an environment variable on the public project, not an admin control.
    for (const file of adminSource) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} sets the public data source`).not.toMatch(/DATA_SOURCE/);
    }
  });

  it('keeps approval distinct from publication', () => {
    const transitions = readFileSync('admin/src/server/transitions.ts', 'utf8');
    // `published` must not be a state a REVIEW action can reach. Approving a
    // submission says it belongs in the record; it does not put it on the site.
    expect(transitions).not.toMatch(/to:\s*'published'/);

    // And `published` is still absent from the submission vocabulary itself.
    const schemaSource = readFileSync('db/schema.ts', 'utf8');
    const submissionEnum = schemaSource.slice(
      schemaSource.indexOf("pgEnum('submission_status'"),
      schemaSource.indexOf("pgEnum('media_kind'"),
    );
    expect(submissionEnum).not.toMatch(/'published'/);
    expect(submissionEnum).toMatch(/'approved'/);
  });

  it('lets nothing reach published without an editor approving it first', () => {
    /**
     * The governance rule, read off the map rather than off a comment. If a
     * future edit adds a shortcut — `pending → published`, say — this fails.
     * `tests/admin-publishing.test.ts` asserts the same thing against a real
     * database; this is the cheap structural version.
     */
    const publishing = readFileSync('admin/src/server/publishing.ts', 'utf8');
    const publishRule = publishing.slice(
      publishing.indexOf('publish: {'),
      publishing.indexOf('archive: {'),
    );
    expect(publishRule).toMatch(/from: \['approved'\]/);
    expect(publishRule).not.toMatch(/'pending'|'draft'|'in_review'/);
  });

  /**
   * Phase 3 made the database a possible read source. What must NOT have
   * changed is where a connection may be opened.
   *
   * The database is read once, before `astro build`, by `db/snapshot.ts`. The
   * render path reads the snapshot that step wrote. So exactly one file under
   * `src/` may name a database driver — the reader the prebuild calls — and no
   * page, component or layout may reach one at all. That is what keeps a
   * static build static and keeps every credential out of the bundle.
   */
  it('opens no database connection in the render path', () => {
    /** The only module under `src/` that may touch the schema. */
    const READER = join('src', 'data', 'source-db.ts');

    for (const file of PUBLIC_SOURCE) {
      if (file === READER) continue;
      const text = readFileSync(file, 'utf8');

      const touchesDatabase = /from '(@\/|\.\.?\/)+(\.\.\/)?db\/(client|pool|schema)'/.test(text);
      if (touchesDatabase) {
        /**
         * Two kinds of file may reach the database, and neither is rendered:
         *
         *   · a serverless function under `src/pages/api/`, which must declare
         *     `prerender = false` — `/api/submit` is the only one
         *   · a server module under `src/server/`, which those functions call
         *
         * Anything else — a page, a component, a layout, a browser script — is
         * in the render path, and a query from there is exactly what the
         * prebuild exists to prevent.
         */
        const posix = file.split(/[\\/]/).join('/');
        const isServerModule = posix.startsWith('src/server/');
        const isApiRoute = posix.startsWith('src/pages/api/');

        expect(
          isServerModule || isApiRoute,
          `${file} reaches the database from the render path`,
        ).toBe(true);

        if (isApiRoute) {
          expect(text, `${file} reaches the database but is prerendered`).toMatch(
            /export const prerender = false/,
          );
        }
      }
    }

    // The reader itself reads the schema and nothing else — no client, no pool.
    const reader = readFileSync(READER, 'utf8');
    expect(reader).toMatch(/db\/schema/);
    expect(reader, 'the reader opens its own connection').not.toMatch(/db\/(client|pool)'/);
    expect(reader, 'the reader creates a driver').not.toMatch(/\bneon\(|new Pool\(/);
  });

  it('keeps the TypeScript record as a working rollback', () => {
    // §24. `DATA_SOURCE=ts` must stay a real path, so these files stay.
    for (const name of ['events', 'cities', 'builders', 'projects', 'ambassadors']) {
      expect(existsSync(`src/data/${name}.ts`), `src/data/${name}.ts`).toBe(true);
    }
    expect(existsSync('src/data/source-ts.ts')).toBe(true);

    // The legacy importer is not retired either.
    expect(existsSync('db/import/index.ts')).toBe(true);

    // And `ts` is still the default: an unset DATA_SOURCE must not read a
    // database. This is the rollback, so it is asserted rather than assumed.
    const source = readFileSync('src/data/source.ts', 'utf8');
    expect(source).toMatch(/return 'ts'/);
  });

  it('has no user-management screen yet', () => {
    // Accounts are created by `npm run db:create-user` and by nothing else.
    expect(existsSync('admin/src/pages/users.astro')).toBe(false);
    expect(existsSync('admin/src/pages/users')).toBe(false);

    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['db:create-user']).toBeDefined();
  });
});
