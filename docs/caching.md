# Caching — what is cached, for how long, and the worst case

Defined in one place: `src/server/http/cache.ts`.

| Response | Cache-Control | Why |
| --- | --- | --- |
| Public SSR pages (home, projects, project, builders, builder, events, event, cities, ambassadors, discover, not-found) | `public, max-age=0, s-maxage=30, stale-while-revalidate=30` | Same bytes for everyone. Browsers revalidate; Vercel's CDN keeps it 30 s and may serve it stale for 30 s more while one request refreshes it. |
| Any render that depends on the viewer — moderator view (`?moderate=1` or a non-public record), `/me/*`, sign-in gates | `private, no-store` + `X-Robots-Tag: noindex` | The CDN does not vary on cookies; a viewer-specific response that were cacheable would be served to the next visitor. |
| API routes | `private, no-store` (route) / `no-store` (vercel.json) | |
| `/sitemap.xml` | `public, max-age=0, s-maxage=300, stale-while-revalidate=300` | |
| `/_astro/*` assets | immutable, 1 year | Content-hashed. |

Previously every SSR page used `s-maxage=60, stale-while-revalidate=86400`,
so content restricted by a moderator could be served from the CDN for up to
a day, and the project/builder detail pages emitted the public header even
when a moderator's controls and banner were in the HTML.

## Invalidation

There is no purge call. Publication, sync and moderation write Neon; the next
CDN refresh reads it. The worst case between a change in Neon and the last
stale public copy is therefore **about 60 seconds** (30 s fresh + 30 s stale),
plus the render time of the refreshing request. This meets the 60-second
moderation target as a bound, not as "immediate". If a stricter guarantee is
ever needed for a surface, switch that surface to `private, no-store` rather
than claim instant removal.

## How this was verified

- `scripts/dev/journey.mjs` asserts the public header on a live project, a
  real 404 after moderation hides it, and `private, no-store` on the
  moderator's view of the hidden project.
- The 60-second bound follows from the header semantics (`s-maxage` +
  `stale-while-revalidate`). It has not been measured on Vercel's CDN from
  this environment; measure it on a preview deployment before relying on it
  for an incident (see the runbook).
