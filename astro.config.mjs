// @ts-check
/**
 * `.env` into `process.env`, before anything reads it.
 *
 * Astro exposes only `PUBLIC_`-prefixed variables through `import.meta.env`,
 * which is the right default — it is what stops `DATABASE_URL` being inlined
 * into a browser bundle. The consequence is that the server-only variables
 * `/api/submit` needs (`DATABASE_URL`, `SUBMISSION_IP_SALT`) are invisible to
 * it in dev unless something loads them, so this does, here, once, in the Node
 * process that runs the dev server and the build. The admin's config does the
 * same thing for the same reason.
 *
 * On Vercel the platform has already populated `process.env` and there is no
 * `.env` file to find, so this is a no-op in production.
 */
import 'dotenv/config';
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';

import { nonIndexablePaths } from './src/lib/indexable.ts';

/**
 * A sitemap that advertises pages marked `noindex` is a crawl-budget bill
 * with no page behind it, so the two have to agree. They read the same
 * function — see `src/lib/indexable.ts` for why it exists and why its imports
 * look the way they do.
 */
const excluded = new Set(nonIndexablePaths().map((path) => `${path}/`));

export default defineConfig({
  site: 'https://www.withclaude.in',
  trailingSlash: 'always',

  /**
   * STATIC FIRST, AND STAYING THAT WAY.
   *
   * `output: 'static'` with an adapter means every page is prerendered at
   * build time exactly as before; only a route that opts out with
   * `export const prerender = false` becomes a serverless function. Today that
   * is `/api/submit` and the nightly rebuild hook, and nothing else — the 71
   * public pages are still files on a CDN.
   *
   * The adapter is here because a submission has to land somewhere, not
   * because the site became an application.
   */
  output: 'static',
  adapter: vercel({ maxDuration: 15 }),
  integrations: [
    sitemap({
      filter: (page) => {
        const path = new URL(page).pathname;
        // `/404` is never a destination, and a city with nothing in it is
        // not a search result — see above.
        if (path === '/404/') return false;
        return !excluded.has(path);
      },
    }),
  ],
  build: { inlineStylesheets: 'auto' },
  image: { service: { entrypoint: 'astro/assets/services/sharp' } },
  vite: {
    build: {
      // The site is static-first; a handful of tiny islands beats one bundle.
      assetsInlineLimit: 2048,
    },
  },
});
