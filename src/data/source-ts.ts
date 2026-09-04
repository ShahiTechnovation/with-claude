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
    events: [...events],
    guides: [...guides],
    projects: [...projects],
    stories: [...stories],
    useCases: [...useCases],
  };
}
