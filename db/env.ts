/**
 * Server-only environment access.
 *
 * The one rule this file exists to keep: a database credential never reaches a
 * browser. Astro inlines any variable prefixed `PUBLIC_` into the client
 * bundle, so a `PUBLIC_DATABASE_URL` would ship the production connection
 * string to every visitor. Rather than trusting nobody will ever add one, the
 * check below refuses to start if one exists.
 *
 * Everything here reads `process.env` and nothing here is importable from a
 * component that runs in the browser — see `tests/security.test.ts`, which
 * asserts the built client bundle contains no connection string.
 */

/** Variables that must never exist, because Astro would publish them. */
const FORBIDDEN = [
  'PUBLIC_DATABASE_URL',
  'PUBLIC_DATABASE_TOKEN',
  'PUBLIC_NEON_DATABASE_URL',
  'PUBLIC_RESEND_API_KEY',
  'PUBLIC_SUBMISSION_IP_SALT',
];

/**
 * Fails loudly if anyone has exposed a secret through a `PUBLIC_` variable.
 *
 * Called from `databaseUrl()` rather than at module load so that importing the
 * schema — which the migration generator and the tests do — never depends on
 * the environment.
 */
export function assertNoPublicSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const leaked = FORBIDDEN.filter((key) => env[key]);
  if (leaked.length > 0) {
    throw new Error(
      `${leaked.join(', ')} is set. Anything prefixed PUBLIC_ is inlined into the browser ` +
        `bundle by Astro. Rename it without the prefix — database and API credentials are ` +
        `server-side only.`,
    );
  }
}

function required(name: string): string {
  assertNoPublicSecrets();
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in, or set it in the ` +
        `Vercel project's environment variables.`,
    );
  }
  return value;
}

/** The Neon connection string. Server-side only, always. */
export function databaseUrl(): string {
  return required('DATABASE_URL');
}

/**
 * The salt mixed into a submitter's IP before it is hashed.
 *
 * Without a salt, a hashed IPv4 address is trivially reversible — the whole
 * space is four billion entries and a laptop walks it in seconds. With one,
 * the stored value is useful for rate limiting and useless for identifying
 * anybody.
 */
export function ipSalt(): string {
  return required('SUBMISSION_IP_SALT');
}

/** Resend credentials. Absent in development, which is handled, not faked. */
export function resendConfig(): { apiKey?: string; from?: string; replyTo?: string } {
  assertNoPublicSecrets();
  return {
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
    replyTo: process.env.RESEND_REPLY_TO,
  };
}

/** True in a deployed environment. Controls how hard missing config fails. */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}
