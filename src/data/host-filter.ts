/**
 * THE SINGLE-HOST EVENT FILTER'S PREDICATE.
 *
 * This site is one ambassador's record (`6e83371`), so every event it shows is
 * one `aniket-sahu` hosts, as headliner, co-host or credited host. Both paths
 * apply it: `records()` in `./dataset` for every prerendered page, and
 * `loadLiveRecords()` in `src/server/directory.ts` for the pages rendered on
 * demand and for the sitemap's event URLs (`resolvableEvents()` in
 * `src/server/public/pages.ts`). One predicate, so the two can't drift.
 *
 * A leaf module with type imports only, so `./dataset`, which every static
 * page reads, never pulls in the DB pool that `directory.ts` carries.
 */
import type { CommunityEvent } from './types';

export function hostedByAniketSahu(event: CommunityEvent): boolean {
  const host = event.host;
  if (!host) return false;
  return (
    host.ambassadorSlug === 'aniket-sahu' ||
    (host.builderSlugs?.includes('aniket-sahu') ?? false) ||
    (host.credits?.some((credit) => credit.ambassadorSlug === 'aniket-sahu') ?? false)
  );
}
