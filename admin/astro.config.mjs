// @ts-check
/**
 * `.env` into `process.env`, before anything reads it.
 *
 * Astro exposes only `PUBLIC_`-prefixed variables through `import.meta.env`,
 * which is exactly the right default — it is what stops a database URL being
 * inlined into a browser bundle. The consequence is that `DATABASE_URL` and
 * `BETTER_AUTH_SECRET` are invisible to server code in dev unless something
 * loads them, so this does, here, once, in the Node process that runs the dev
 * server and the build.
 *
 * On Vercel the platform has already populated `process.env` and there is no
 * `.env` file to find, so this is a no-op in production.
 */
import 'dotenv/config';
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

/**
 * admin.withclaude.in
 *
 * The opposite of the public site in every way that matters:
 *
 *   withclaude.in        output: 'static'   71 files on a CDN, no session
 *   admin.withclaude.in  output: 'server'   every response rendered per request
 *
 * `output: 'server'` because there is no page here that is the same for two
 * people. A queue is who is waiting on you; a submission carries somebody's
 * email address. Prerendering any of it would mean writing private data to a
 * file and hoping nothing serves it.
 *
 * A SEPARATE ORIGIN, NOT A ROUTE. The two applications share `db/` and share
 * nothing else — no cookie, no bundle, no build. That is what makes the
 * statement "the public site has no authentication" a fact about the artifact
 * rather than a claim about the code.
 */
/**
 * ── WHERE THIS RUNS, AND WHY IT IS THE WHOLE PERFORMANCE STORY ───────────
 *
 * The region is set in `vercel.json` — `regions: ["sin1"]` — because that file
 * is the only thing Vercel reads for it, and JSON cannot hold the reason. The
 * reason is here.
 *
 * Neon lives in `ap-southeast-1`. Until sin1 was pinned, this function was
 * built for `iad1` (Washington DC), the platform default, so every single SQL
 * statement left Virginia, crossed the Pacific, and came back.
 *
 * Measured against production on 2026-09-07, before the change:
 *
 *     GET  /login    0 database queries    ~305ms TTFB
 *     POST /login    1 database query      ~526ms TTFB
 *                                          ────────
 *     one round trip to the database        ~220ms
 *
 * The queries are not slow. `EXPLAIN ANALYZE` puts every one of them between
 * 0.04ms and 0.10ms — these tables hold tens of rows and the indexes that
 * matter already exist. The 220ms was distance and nothing else, and it was
 * paid once per statement, on every page, forever.
 *
 * sin1 IS ap-southeast-1, so this colocates the function with the database,
 * which is what Neon recommends. ONE region, deliberately, not a list: a
 * second region would not make anything faster, it would only mean some
 * fraction of requests went back to being the slow ones.
 */
export default defineConfig({
  site: process.env.BETTER_AUTH_URL ?? 'https://admin.withclaude.in',
  output: 'server',
  // `true` compresses losslessly: whitespace that can show, line breaks included, stays as a
  // space. Astro 7's default, 'jsx', drops line breaks around elements, so words and links on
  // separate lines in the markup would touch. Unlike Astro 5's `true`, a line break right after
  // an inline element now renders as a space: keep punctuation on the closing tag's line
  // (tests/sentence-spacing.test.ts).
  compressHTML: true,
  adapter: vercel({
    maxDuration: 20,

    /**
     * The workspace's own self-link.
     *
     * npm creates `node_modules/with-claude-admin -> ../admin` for the
     * workspace, and the function tracer follows it. Recreating it inside the
     * bundle is pure redundancy — the admin's compiled entrypoint is already
     * copied in — and reproducing a directory symlink is the one filesystem
     * operation Windows refuses without Developer Mode, so on a contributor's
     * laptop it turns a working build into an EPERM. Excluded rather than
     * worked around.
     */
    excludeFiles: ['../node_modules/with-claude-admin'],
  }),

  /**
   * WHY THIS EXISTS: behind Vercel, TLS terminates at the edge, and the
   * browser's real scheme and host reach the function only in
   * `X-Forwarded-Proto` and `X-Forwarded-Host`. Astro 7 applies them to
   * `Astro.url` only when they match an entry here
   * (`FetchState#applyForwardedHeaders`, checked by
   * `astro/dist/core/app/validate-headers.js`). With an empty list it never
   * trusts them, and `Astro.url` stays the URL the platform built for the
   * function's request, which need not be the origin the browser used.
   *
   * `security.checkOrigin` then compares the browser's real `Origin` against
   * that origin, and when they differ every form POST — including the sign-in
   * form, which is a plain `<form>` by design — is answered 403 "Cross-site
   * POST form submissions are forbidden" by an internal middleware that runs
   * BEFORE `src/middleware.ts` and before any route. Under Astro 5 and adapter
   * 9 the fallback was `http://localhost`, and that is how this admin once
   * answered 403 to its own sign-in form.
   *
   * THE FIX IS AN ALLOWLIST, NOT AN EXEMPTION. `checkOrigin` stays on. This
   * only tells Astro which forwarded hosts are really ours, which is exactly
   * what the option is for: it is the defence against host-header injection,
   * so the patterns are kept narrow and explicit rather than `**`.
   */
  security: {
    checkOrigin: true,
    allowedDomains: [
      /**
       * Production. Exact host, so the real admin origin never depends on the
       * wildcard below.
       */
      { protocol: 'https', hostname: 'admin.withclaude.in' },

      /**
       * Vercel preview and deployment URLs.
       *
       * `**.vercel.app` is deliberately this shape and not narrower: Astro's
       * matcher (`@astrojs/internal-helpers/remote`) only honours a wildcard as
       * a LEADING `*.` or `**.` label. A mid-string pattern such as
       * `with-claude-admin-*.vercel.app` is not a wildcard to it at all — it
       * degrades to an exact string compare and silently never matches, which
       * would leave preview deployments still answering 403.
       *
       * The residual risk is small and bounded, and it is narrowed again one
       * layer up. `X-Forwarded-Host` is set by Vercel's edge, which overwrites
       * any client-supplied value, so it is not attacker-controlled in this
       * deployment. Even if it were, the only thing it moves is `Astro.url` —
       * and `src/server/origin.ts` then requires that origin to be this
       * project's own `with-claude-admin*.vercel.app` namespace before it may
       * mint or spend a session, so a wildcard match here is not enough on its
       * own. The session cookie is host-only either way. Production above does
       * not rely on this entry.
       */
      { protocol: 'https', hostname: '**.vercel.app' },
    ],
  },

  /**
   * Nothing here should ever be indexed, linked from a sitemap, or shared to a
   * social card. The middleware sets `X-Robots-Tag` on every authenticated
   * response; `public/robots.txt` covers the login page too.
   */
  build: { inlineStylesheets: 'auto' },

  vite: {
    // `db/` lives above this package's root. Vite needs permission to read it
    // in dev; the build bundles it normally.
    server: { fs: { allow: ['..'] } },
  },
});
