/**
 * The TypeScript record, as a data source.
 *
 * This is the legacy source and the rollback path. It is deliberately trivial:
 * the record arrays are already exactly the shape a source must produce, so
 * there is no mapping layer here and there must not be one. Anything clever in
 * this file would be a difference between the two sources that has nothing to
 * do with the database.
 *
 * Do not retire this in Phase 3. `DATA_SOURCE=ts` is what the site falls back
 * to if the database read turns out to be wrong in production, and that
 * fallback is only real while these imports still work.
 */
import { ambassadors } from './ambassadors';
import { builders } from './builders';
import { cities } from './cities';
import { events } from './events';
import { guides } from './guides';
import { projects } from './projects';
import { stories } from './stories';
import { useCases } from './use-cases';
import type { RecordSet } from './source';
/**
 * RELATIVE, NOT `@/lib/credits`.
 *
 * `astro.config.mjs` loads `src/lib/indexable.ts`, which loads `./dataset`,
 * which loads this file — all of it before Astro has registered the `@` alias.
 * An aliased import here breaks the config load and therefore the whole build,
 * which is the build-order trap `src/lib/indexable.ts` documents at length.
 */
import { curatedCredits, sortCredits } from '../lib/credits';

/**
 * The record as the repository holds it.
 *
 * Returned as fresh arrays rather than the imported ones so a caller cannot
 * sort or splice the module's own state out from under every other page in the
 * build. The records inside are shared and are treated as immutable, which is
 * how the site has always treated them.
 */
export function tsRecordSet(): RecordSet {
  return {
    ambassadors: [...ambassadors],
    builders: [...builders],
    cities: [...cities],
    /**
     * ── THE ONE MAPPING IN THIS FILE, AND WHY IT IS ALLOWED ──────────────
     *
     * The header says there is no mapping layer here and there must not be
     * one. This is the exception, and it is the kind that proves the rule:
     * `EventHost.credits` mirrors `event_hosts`, a table the TypeScript record
     * has no equivalent of, so a source that left it undefined would produce a
     * `RecordSet` the database source could never match and the equivalence
     * suite would fail on every event.
     *
     * It is not "clever" in the sense the header warns about, because it makes
     * no decision: `curatedCredits()` holds the single rule, and the importer
     * and migration 0012 derive the database's rows from the same function.
     * All three therefore agree by construction rather than by review.
     */
    events: events.map((event) => ({
      ...event,
      host: { ...event.host, credits: sortCredits(curatedCredits(event.host)) },
    })),
    guides: [...guides],
    projects: [...projects],
    stories: [...stories],
    useCases: [...useCases],
  };
}
