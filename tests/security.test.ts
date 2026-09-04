import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertNoPublicSecrets } from '../db/env';
import { forms } from '../src/data/forms';

/**
 * The two promises this file exists to keep.
 *
 *  1. A DATABASE CREDENTIAL NEVER REACHES A BROWSER. Astro inlines anything
 *     prefixed `PUBLIC_` into the client bundle, so the failure mode is one
 *     careless rename away. `db/env.ts` refuses to start if such a variable
 *     exists, and the bundle itself is searched below.
 *
 *  2. A SUBMITTER'S EMAIL IS NEVER PUBLISHED. Every form promises this in so
 *     many words ("your email is used to reach you and is never displayed").
 *     There is no public read path to the `submissions` table at all, which is
 *     the only way to guarantee it, and the built site is searched for the
 *     private column names to prove none leaked into a page.
 *
 * The bundle checks need a build. When `dist/` is absent they say so and skip
 * rather than passing quietly — a security test that silently does nothing is
 * worse than no test.
 */

const CLIENT_DIRS = ['dist/client', 'dist', '.vercel/output/static'];

function existingClientDir(): string | undefined {
  for (const dir of CLIENT_DIRS) {
    try {
      if (statSync(dir).isDirectory()) {
        // `dist` is only the client root when there is no `dist/client`.
        if (dir === 'dist') {
          try {
            if (statSync('dist/client').isDirectory()) continue;
          } catch {
            /* no dist/client — `dist` is the client root */
          }
        }
        return dir;
      }
    } catch {
      /* not built */
    }
  }
  return undefined;
}

function filesUnder(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(path);
    }
  };
  walk(dir);
  return out;
}

describe('database credentials stay server-side', () => {
  it('refuses to read any secret exposed through a PUBLIC_ variable', () => {
    for (const name of [
      'PUBLIC_DATABASE_URL',
      'PUBLIC_NEON_DATABASE_URL',
      'PUBLIC_RESEND_API_KEY',
      'PUBLIC_SUBMISSION_IP_SALT',
    ]) {
      process.env[name] = 'should-never-be-set';
      try {
        expect(() => assertNoPublicSecrets(), name).toThrow(new RegExp(name));
      } finally {
        delete process.env[name];
      }
    }
  });

  it('passes when nothing is exposed', () => {
    expect(() => assertNoPublicSecrets({})).not.toThrow();
  });

  it('names no PUBLIC_ database variable anywhere in the source', () => {
    // A grep, deliberately. The rule is worth failing on at the string level,
    // because by the time it is a real import it is already in the bundle.
    for (const dir of ['src', 'db']) {
      for (const file of filesUnder(dir, ['.ts', '.astro', '.mjs', '.js'])) {
        const text = readFileSync(file, 'utf8');
        // `db/env.ts` and this test name them in order to forbid them.
        if (file.includes('env.ts') || file.includes('security.test')) continue;
        expect(text, file).not.toMatch(/PUBLIC_[A-Z_]*(DATABASE|NEON|RESEND|SALT)/);
      }
    }
  });

  it('ships no connection string or API key in the browser bundle', () => {
    const dir = existingClientDir();
    // Fail rather than skip: this is the assertion that matters most, and a
    // quiet skip is how it would stop running without anyone noticing.
    expect(dir, 'run `npm run build` before the security tests').toBeDefined();

    const files = filesUnder(dir!, ['.js', '.html', '.css', '.json', '.xml']);
    expect(files.length).toBeGreaterThan(0);

    const forbidden: [RegExp, string][] = [
      [/postgres(ql)?:\/\//i, 'a PostgreSQL connection string'],
      [/\bneon\.tech\b/i, 'a Neon host'],
      [/\bre_[A-Za-z0-9]{16,}/, 'a Resend API key'],
      [/DATABASE_URL/, 'the DATABASE_URL name'],
      [/SUBMISSION_IP_SALT/, 'the IP salt'],
      [/RESEND_API_KEY/, 'the Resend key name'],
      [/CRON_SECRET/, 'the cron secret name'],
      [/VERCEL_DEPLOY_HOOK_URL/, 'the deploy hook'],
    ];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, description] of forbidden) {
        expect(pattern.test(text), `${file} contains ${description}`).toBe(false);
      }
    }
  });

  it('ships no server-only module into a client script', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();

    for (const file of filesUnder(dir!, ['.js'])) {
      const text = readFileSync(file, 'utf8');
      // Distinctive strings from the server-only modules. Their presence in a
      // browser script would mean the boundary has been crossed.
      expect(text, `${file} bundles the Drizzle schema`).not.toMatch(
        /audit_log is append-only|drizzle-orm\/neon-http/,
      );
      expect(text, `${file} bundles the mailer`).not.toMatch(/api\.resend\.com/);
    }
  });
});

describe('private submission fields stay private', () => {
  const PRIVATE_COLUMNS = ['submitter_email', 'submitterEmail', 'ip_hash', 'ipHash', 'user_agent'];

  it('renders no private column name into any built page', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();

    for (const file of filesUnder(dir!, ['.html', '.js', '.xml'])) {
      const text = readFileSync(file, 'utf8');
      for (const column of PRIVATE_COLUMNS) {
        expect(text.includes(column), `${file} mentions ${column}`).toBe(false);
      }
    }
  });

  it('has no public read route over submissions', () => {
    // The guarantee is structural: there is no GET handler, and no route file
    // that selects from the table. If one is ever added, this fails.
    const routes = filesUnder('src/pages', ['.ts', '.astro', '.js']);

    for (const file of routes) {
      const text = readFileSync(file, 'utf8');
      if (!/submissions|cityInterest|city_interest/.test(text)) continue;

      // The only file allowed to touch these tables is the submit endpoint,
      // and it only inserts.
      expect(file.replace(/\\/g, '/'), 'only /api/submit may touch the inbox').toBe(
        'src/pages/api/submit.ts',
      );
    }
  });

  it('exposes no submissions table anywhere in a prerendered page', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();

    for (const file of filesUnder(dir!, ['.html'])) {
      const text = readFileSync(file, 'utf8');
      expect(/from\s+submissions|select .* submissions/i.test(text), file).toBe(false);
    }
  });
});

describe('the site stays static', () => {
  it('marks only the API routes as server-rendered', () => {
    const dynamic = filesUnder('src/pages', ['.astro', '.ts']).filter((file) =>
      /export\s+const\s+prerender\s*=\s*false/.test(readFileSync(file, 'utf8')),
    );

    expect(dynamic.map((f) => f.replace(/\\/g, '/')).sort()).toEqual([
      'src/pages/api/cron/rebuild.ts',
      'src/pages/api/submit.ts',
    ]);
  });

  it('builds every public page as a file', () => {
    const dir = existingClientDir();
    expect(dir).toBeDefined();
    // The whole public site, still on disk.
    expect(filesUnder(dir!, ['.html']).length).toBeGreaterThan(60);
  });
});

describe('the forms are wired to the endpoint', () => {
  it('points all four at /api/submit', () => {
    expect(forms.length).toBe(4);
    for (const form of forms) {
      expect(form.endpoint, `form ${form.id}`).toBe('/api/submit/');
    }
  });

  it('asks every form for an email, so every submission can be acknowledged', () => {
    for (const form of forms) {
      const email = form.fields.find((f) => f.type === 'email');
      expect(email, `form ${form.id}`).toBeDefined();
      expect(email!.required, `form ${form.id} email is required`).toBe(true);
      // And says out loud that it is never published.
      expect(email!.hint ?? '', `form ${form.id} email hint`).toMatch(
        /never published|never displayed/i,
      );
    }
  });

  it('keeps the clipboard fallback in the client script', () => {
    const script = readFileSync('src/scripts/submit.ts', 'utf8');
    // The composed text is produced on every path, including failure, so a
    // person never loses what they typed.
    expect(script).toMatch(/Sending failed/);
    expect(script).toMatch(/navigator\.clipboard/);
    expect(script).toMatch(/function compose/);
  });
});
