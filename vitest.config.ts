import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest gets the same `@` alias the app has.
 *
 * Without it the tests can only reach modules that happen to import nothing
 * aliased, which quietly limited them to the leaf data files and the pure
 * helpers — the selector layer in `src/data/index.ts`, where most of the
 * derivation actually lives, was untestable by accident rather than by
 * decision. This is one line of config and it opens all of it up.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
