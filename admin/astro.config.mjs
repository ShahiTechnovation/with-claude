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
export default defineConfig({
  site: process.env.BETTER_AUTH_URL ?? 'https://admin.withclaude.in',
  output: 'server',
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
