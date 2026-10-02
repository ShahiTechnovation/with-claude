import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Vitest gets the same `@` alias the app has.
 *
 * Without it the tests can only reach modules that happen to import nothing
 * aliased, which quietly limited them to the leaf data files and the pure
 * helpers — the selector layer in `src/data/index.ts`, where most of the
 * derivation actually lives, was untestable by accident rather than by
 * decision. This is one line of config and it opens all of it up.
 *
 * `@db` is the ADMIN app's alias for `../db` (see `admin/tsconfig.json`), not
 * this project's own. It is added here for the same reason: without it,
 * `admin/src/server/*.ts` modules that import `@db/schema` cannot be reached
 * from a root-level test at all, which would otherwise mean the admin's
 * ambassador/attribution server logic can only be exercised by clicking
 * through a browser — the one thing this test file exists to make optional.
 */
/**
 * `tests/equivalence-neon.test.ts` needs a live Neon credential, and by its
 * own header is not part of `npm test`: it is run on purpose, by name —
 *
 *     npx vitest run tests/equivalence-neon.test.ts
 *
 * — and fails loudly when the credential is missing. So it is left out of
 * every run that does not name it, rather than skipped inside the file, where
 * a green run would claim a check against Neon that never happened.
 */
const NEON_SUITE = 'tests/equivalence-neon.test.ts';
const neonSuiteNamed = process.argv.some((arg) => arg.includes('equivalence-neon'));

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@db': fileURLToPath(new URL('./db', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(neonSuiteNamed ? [] : [NEON_SUITE])],
  },
});
