// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://withclaude.in',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'auto' },
  image: { service: { entrypoint: 'astro/assets/services/sharp' } },
  vite: {
    build: {
      // The site is static-first; a handful of tiny islands beats one bundle.
      assetsInlineLimit: 2048,
    },
  },
});
