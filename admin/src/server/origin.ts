/**
 * Which origin is this admin actually being served on, and is it one of ours?
 *
 * ── THE BUG THIS FILE EXISTS TO FIX ──────────────────────────────────────
 *
 * `assertSameOrigin()` used to compare the browser's `Origin` header against
 * `BETTER_AUTH_URL`. That is not a same-origin check. It is a *canonical*
 * origin check, and the two stop agreeing the moment the application answers
 * on more than one hostname.
 *
 * Vercel makes that the normal case rather than the exception. One deployment
 * is reachable on all of:
 *
 *     admin.withclaude.in                                    the custom domain
 *     with-claude-admin.vercel.app                           the project alias
 *     with-claude-admin-<team>.vercel.app                    the team alias
 *     with-claude-admin-git-<branch>-<team>.vercel.app       the branch alias
 *     with-claude-admin-<hash>-<team>.vercel.app             this commit
 *
 * and it mints a new one of the last two on every single push. A form posted
 * from any of them is genuinely same-origin — the browser sent `Origin` equal
 * to the host it loaded the page from — and every one of them except the
 * canonical string was being refused with "That request did not come from
 * this site."
 *
 * ── WHAT REPLACES IT ─────────────────────────────────────────────────────
 *
 * Exactly the comparison Astro's own `security.checkOrigin` makes:
 *
 *     request.headers.get('origin') === new URL(request.url).origin
 *
 * The important part is that `request.url` is NOT the raw `Host` header.
 * Astro builds it in `NodeApp.createRequest()` as
 *
 *     validatedForwardedHost ?? validatedHost ?? 'localhost'
 *
 * where both validators test the host against `security.allowedDomains` from
 * `astro.config.mjs` and return undefined for anything not on that list. A
 * forged `Host` or `X-Forwarded-Host` therefore never reaches this file — it
 * has already been discarded, and the origin has fallen back to
 * `http://localhost`, which no browser on the public internet will ever send
 * as its `Origin`.
 *
 * So the host arrives here already validated once, by the framework, against
 * a config-level allowlist. This file then asks the second question.
 */

/**
 * The production origin, stated literally.
 *
 * Not read from an environment variable, because the one thing that must be
 * true of the real admin origin is that it does not depend on a value
 * somebody can mistype in a dashboard.
 */
const PRODUCTION_ORIGIN = 'https://admin.withclaude.in';

/**
 * This project's own namespace on `vercel.app`.
 *
 * Every hostname Vercel assigns to a deployment of this project begins with
 * the project name and ends in `.vercel.app`; the middle is a per-deployment
 * hash, a branch slug, a team slug, or nothing at all. They cannot be
 * enumerated ahead of time, which is why this is a pattern and not a list —
 * the previous attempt at this hardcoded one team-slug suffix and so matched
 * the branch alias while missing `with-claude-admin.vercel.app` entirely.
 *
 * Anchored at BOTH ends, which is the part that matters:
 *
 *     with-claude-admin.vercel.app.evil.com     rejected — `$` after .app
 *     evil-with-claude-admin.vercel.app         rejected — `^` before the name
 *     with-claude-admin.evil.com                rejected — literal .vercel.app
 *     anything-else.vercel.app                  rejected — wrong project
 *
 * `https` only: an origin this admin would set a Secure cookie for is never
 * plaintext.
 */
const VERCEL_ORIGIN = /^https:\/\/with-claude-admin(?:-[a-z0-9-]+)?\.vercel\.app$/;

/** `astro dev` and `astro preview`, on whichever port they landed on. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

/** `BETTER_AUTH_URL` reduced to an origin, or nothing if it is unusable. */
function configuredOrigin(): string | undefined {
  const configured = process.env.BETTER_AUTH_URL;
  if (!configured) return undefined;
  try {
    return new URL(configured).origin;
  } catch {
    // A malformed value trusts nothing, rather than everything.
    return undefined;
  }
}

/**
 * May this origin mint or spend an admin session?
 *
 * Deliberately NOT the same list as `security.allowedDomains` in
 * `astro.config.mjs`. That one decides which forwarded host Astro will
 * believe; this one decides which believed host counts as the admin. Keeping
 * them apart means widening the framework's allowlist later — for a health
 * check, for a new adapter, for a preview tool — cannot silently widen what
 * is allowed to hold an authenticated session.
 */
export function isTrustedOrigin(origin: string): boolean {
  if (origin === PRODUCTION_ORIGIN) return true;
  if (VERCEL_ORIGIN.test(origin)) return true;

  // Whatever this particular deployment was configured with: the custom
  // domain in production, the preview URL in preview, a localhost port in
  // development. Included so a new domain works by setting one variable.
  if (origin === configuredOrigin()) return true;

  /**
   * Loopback is a development affordance and must never be one in a
   * deployment. On Vercel a `localhost` origin can only mean Astro rejected
   * the forwarded host and fell through — a failure to refuse, not a host to
   * trust.
   */
  if (!process.env.VERCEL && LOOPBACK_ORIGIN.test(origin)) return true;

  return false;
}

/**
 * The origin this request was really served on, as Astro resolved it against
 * `security.allowedDomains`.
 *
 * Returns undefined rather than a string for an opaque origin: `null` is what
 * a sandboxed iframe or a `data:` document serialises to, and two of them
 * comparing equal must never read as a match.
 */
export function validatedRequestOrigin(request: Request): string | undefined {
  try {
    const { origin } = new URL(request.url);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}
