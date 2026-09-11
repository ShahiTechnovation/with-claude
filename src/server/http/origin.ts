/**
 * Which origin is the public site actually being served on, and is it ours?
 *
 * The public counterpart of `admin/src/server/origin.ts`. That file carries
 * the full argument for why a same-origin check must compare against the host
 * the response is being served from and never against a canonical string in
 * an environment variable; it was written after `BETTER_AUTH_URL` turned every
 * Vercel alias except one into an apparent attacker. The reasoning applies
 * here unchanged, so it is not repeated — read that file.
 *
 * ── WHY THERE ARE TWO COPIES OF THIS POLICY ──────────────────────────────
 *
 * Because they are two applications with two sets of legitimate origins, and
 * the values differ: `admin.withclaude.in` versus `www.withclaude.in`,
 * `with-claude-admin*.vercel.app` versus `with-claude*.vercel.app`. What is
 * shared is the shape of the check, not the data.
 *
 * They should still converge. Phase C reworks the admin, and collapsing both
 * into one module parameterised by its origins belongs in that change rather
 * than in a phase whose brief says not to touch admin configuration.
 *
 * ── WHY THE PUBLIC SITE NEEDS THIS AT ALL NOW ────────────────────────────
 *
 * Astro's own `security.checkOrigin` only guards form-encoded bodies —
 * `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`.
 * A JSON POST is not checked by it, which is exactly why `/api/submit` has
 * always worked. Every Phase A mutation takes JSON, so every Phase A mutation
 * is outside that protection and has to bring its own.
 */

/**
 * The production origin, stated literally.
 *
 * Not read from an environment variable, for the same reason the admin's is
 * not: the one thing that must be true of the real public origin is that it
 * does not depend on a value somebody can mistype in a dashboard.
 *
 * Both hosts, because both answer — `withclaude.in` redirects to `www`, but a
 * request that arrives on the apex is still served, and a page loaded there
 * posts with that `Origin`.
 */
const PRODUCTION_ORIGINS = ['https://www.withclaude.in', 'https://withclaude.in'];

/**
 * This project's own namespace on `vercel.app`.
 *
 * Anchored at both ends, which is the part that matters:
 *
 *     with-claude.vercel.app.evil.com     rejected — `$` after .app
 *     evil-with-claude.vercel.app         rejected — `^` before the name
 *     with-claude.evil.com                rejected — literal .vercel.app
 *     with-claude-admin.vercel.app        rejected — that is the OTHER app
 *
 * The last one is deliberate and worth stating: the admin and the public site
 * are separate deployments with separate authentication systems, and a POST
 * from the admin's origin into a public member endpoint is cross-origin as far
 * as this file is concerned.
 */
const VERCEL_ORIGIN = /^https:\/\/with-claude(?:-[a-z0-9-]+)?\.vercel\.app$/;

/** `astro dev` and `astro preview`, on whichever port they landed on. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

/** May a page on this origin call the member API? */
export function isTrustedOrigin(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (PRODUCTION_ORIGINS.includes(origin)) return true;

  // `with-claude-admin…` must not match, so the admin pattern is excluded
  // before the public one is tested.
  if (/^https:\/\/with-claude-admin(?:-[a-z0-9-]+)?\.vercel\.app$/.test(origin)) return false;
  if (VERCEL_ORIGIN.test(origin)) return true;

  /**
   * Loopback is a development affordance and must never be one in a
   * deployment. On Vercel a `localhost` origin can only mean Astro rejected
   * the forwarded host and fell through — a failure to refuse, not a host to
   * trust.
   */
  if (!env.VERCEL && LOOPBACK_ORIGIN.test(origin)) return true;

  return false;
}

/**
 * The origin this request was really served on, as Astro resolved it against
 * `security.allowedDomains`.
 *
 * Returns undefined for an opaque origin: `null` is what a sandboxed iframe or
 * a `data:` document serialises to, and two of them comparing equal must never
 * read as a match.
 */
export function validatedRequestOrigin(request: Request): string | undefined {
  try {
    const { origin } = new URL(request.url);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * Same-origin check for a state-changing request.
 *
 * BOTH LOCKS HAVE TO HOLD:
 *
 *   1. the browser's `Origin` equals the origin this response is served from.
 *      This is the CSRF control. A page on `evil.example` posting here sends
 *      `Origin: https://evil.example`, which is not the origin this request
 *      was served on, and is refused. A browser will not let a page forge
 *      this header, which is the whole reason it exists.
 *
 *   2. that origin is one this site is allowed to be served on at all.
 *      Defence in depth against a host-header injection that got past
 *      `security.allowedDomains`: a host we never intended cannot become the
 *      trusted origin merely by asserting itself consistently in two headers.
 *
 * `Referer` is accepted as a fallback for `Origin` because some clients omit
 * `Origin` on same-origin requests. It is a weaker signal, but it is only ever
 * used to satisfy a comparison against the served origin — it cannot widen
 * what is allowed.
 */
export function assertSameOrigin(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const candidate = request.headers.get('origin') ?? request.headers.get('referer');
  if (!candidate) return false;

  const served = validatedRequestOrigin(request);
  if (!served) return false;

  let claimed: string;
  try {
    claimed = new URL(candidate).origin;
  } catch {
    return false;
  }

  // An opaque origin is not this site, whatever it is.
  if (claimed === 'null') return false;

  // FIRST LOCK — the same-origin comparison itself.
  if (claimed !== served) return false;

  // SECOND LOCK — and is that an origin we answer on?
  return isTrustedOrigin(served, env);
}

/**
 * `Sec-Fetch-Site`, where the browser sends it.
 *
 * A third, cheap signal that costs nothing to check and that no cross-site
 * request can set. Absent on older browsers and on non-browser callers, so a
 * missing header is not a failure — only a present-and-wrong one is.
 */
export function fetchSiteAllows(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (!site) return true;
  return site === 'same-origin' || site === 'none';
}
