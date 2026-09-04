// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

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
