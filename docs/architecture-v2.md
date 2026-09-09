# WITH CLAUDE v2 — the user-driven platform

**Status:** proposed. Nothing in this document is implemented yet.
**Written:** 2026-09-09, after reading the repository, the schema, the admin, and
probing the two external sources v2 depends on.

This is the §73 deliverable: what changes, why, and in what order. It is meant to
be argued with before any of it is built.

---

## 0. What the repository actually is today

Facts established by reading it, because several of them constrain everything
below.

| Thing | Today |
| --- | --- |
| Public site | Astro, `output: 'static'`. 2 server routes total (`/api/submit`, `/api/cron/rebuild`). Every other page is a file on a CDN. |
| Data path | `src/data/index.ts` → ~40 **synchronous** selectors over one in-memory `RecordSet`. `DATA_SOURCE=ts` (the default, and what production runs) imports `src/data/*.ts`; `DATA_SOURCE=db` reads a snapshot the prebuild wrote. |
| Database | Neon + Drizzle. Schema written and migrated (0000–0005), repository data imported. Production still renders from TypeScript. |
| Admin | Separate Astro app, better-auth, role read fresh from `users` on every request, one state machine (`transitionSubmission`), append-only audit log, transactional. |
| Records | 71 builders, 26 projects, 14 events, 14 cities, 1 ambassador, 0 stories/use-cases/guides. |
| Search | Index built at build time from the selectors; `search-core.ts` scoring runs twice (build + browser island) from one implementation. |
| Media | `media` is metadata over paths under `src/assets`. Git is the store. No uploads. |
| Regions | `admin/vercel.json` pins `sin1`. The public project pins nothing — fine with 2 functions, **not** fine in v2. |

Three properties of the existing design are load-bearing and v2 must not break
them, because they are why the site is trustworthy:

1. **A city's state is derived**, never stored. No column can fake a chapter.
2. **An event's lifecycle is the clock.** Only door states are authored.
3. **Ambassador status is not self-assignable** — enforced by a `CHECK`.

And one property is load-bearing for *speed*: there is no database connection
open at render time, so no page can issue a query. v2 has to give some of that
up — §41–§44 require it. The design below gives up as little as possible, in
named places, with the cost written down.

---

## A. Schema changes

Five migrations, one per phase, each shippable alone. `db/schema.ts` grows;
nothing existing is dropped.

### A.1 — `0006_members` (Phase A)

New enums: `member_status` (`active`, `suspended`, `deleted`),
`identity_provider` (`email`, `google`, `github`, `linkedin`, `x`, `wallet`),
`claim_status` (`auto_resolved`, `pending`, `approved`, `rejected`, `withdrawn`),
`claim_proof_type` (`linkedin_identity`, `github_identity`, `email_match`,
`handle_match`, `moderator_review`).

```
members              id, privy_user_id UNIQUE, status, created_at, updated_at, last_seen_at
member_profiles      member_id PK/FK, username UNIQUE, display_name, first_name, last_name,
                     avatar_media_id, headline, bio, city_id, country, organization_id,
                     website, availability, claude_since, primary_role,
                     public_email bool default false, claude_stack text[],
                     published_at, created_at, updated_at
member_identities    member_id, provider, provider_subject, username, display_name,
                     profile_url, verified_at        UNIQUE (provider, provider_subject)
member_wallets       member_id, chain, address, wallet_type, verified_at
profile_claims       id, member_id, entity_type, entity_id, proof_type,
                     proof_value_hash, status, created_at, resolved_at,
                     resolved_by (admin users.id), note
```

Plus `builders.owner_member_id uuid NULL REFERENCES members(id) ON DELETE SET NULL`.
Nullable is the point: 71 legacy builders keep `NULL` until claimed (§7).

Constraints that carry rules rather than describing them:

- `member_profiles.username` — `CHECK` on shape (`^[a-z0-9][a-z0-9-]{1,29}$`) plus a
  reserved-word table, so `admin`, `me`, `api`, `events` can never become a handle
  that shadows a route.
- `profile_claims` — partial `UNIQUE (entity_type, entity_id) WHERE status IN
  ('auto_resolved','approved')`. **One resolved claim per record, ever.** This is
  the database refusing §6's "never allow a member to arbitrarily attach
  themselves to another person", rather than a route remembering to check.
- `UNIQUE (member_id, entity_type, entity_id)` on open claims — no re-submitting
  the same claim to wear a moderator down.
- `proof_value_hash` is a hash, never the value. A claims table must not become a
  store of other people's email addresses.

**Deliberately absent:** any `role`, `verified`, `official` or `trust` column a
member can write to. §19/§60 trust signals are Phase C, on their own table, keyed
to moderator identity.

### A.2 — `0007_self_publishing` (Phase B)

This is the migration with a real decision in it.

New enums: `publication_status` (`draft`, `published`, `archived`, `deleted`),
`moderation_state` (`clean`, `reported`, `restricted`, `archived`),
`content_source` (`legacy`, `user`, `luma`, `import`).

Added to `builders`, `projects`, `stories`, `use_cases`, `guides`:

```
owner_member_id      uuid NULL REFERENCES members(id) ON DELETE SET NULL
publication_status   publication_status NOT NULL DEFAULT 'draft'
moderation_state     moderation_state   NOT NULL DEFAULT 'clean'
source               content_source     NOT NULL DEFAULT 'legacy'
published_at         timestamptz NULL
deleted_at           timestamptz NULL
deleted_by           uuid NULL              -- admin users.id
deletion_reason      text NULL
```

**What happens to `status content_status`.** §9 says do not collapse publication
and moderation into one field; §10 says the legacy states stay "only where
necessary". Keeping `status` readable alongside the new pair would create two
answers to "is this public?" — the exact failure `db/schema.ts`'s own header is
written against. So:

1. The migration **backfills** deterministically, and one shared pure function
   (`publicationOf(legacyStatus)`) does the same mapping for both data sources, so
   there is one implementation rather than two:

   | `status` | → `publication_status` | → `moderation_state` |
   | --- | --- | --- |
   | `published` | `published` | `clean` |
   | `archived` | `archived` | `archived` |
   | `rejected` | `archived` | `restricted` |
   | `draft`, `pending`, `in_review`, `changes_requested`, `approved` | `draft` | `clean` |

2. `status` is then **frozen, not dropped**: kept for one release as the rollback
   witness, read by nothing. A `0007b` follow-up drops it once the admin has
   stopped writing it and a production build has run green off the new columns.

3. `isPublic()` becomes `publication_status = 'published' AND moderation_state <>
   'archived' AND deleted_at IS NULL`. One predicate, one place, both sources —
   which is what keeps the existing equivalence suite meaningful.

`RecordBase.status` in `src/data/types.ts` is replaced by `publication` +
`moderation`. `source-ts.ts` keeps its promise of having no mapping layer by
calling the shared `publicationOf()` — the same function `source-db.ts` calls for
legacy rows.

Also in 0007:

```
project_members       project_id, member_id, role ('owner'|'collaborator'|'contributor'),
                      can_edit bool, can_publish bool, invited_by, joined_at
                      PK (project_id, member_id)
content_revisions     id, entity_type, entity_id, editor_member_id, revision_number,
                      snapshot_json, created_at
                      UNIQUE (entity_type, entity_id, revision_number)
```

- `project_members` — partial `UNIQUE (project_id) WHERE role = 'owner'`. Exactly
  one owner. `CHECK (role <> 'owner' OR (can_edit AND can_publish))`.
- `projects.owner_member_id` is required for new rows only, expressed as
  `CHECK (source = 'legacy' OR owner_member_id IS NOT NULL)` rather than a plain
  `NOT NULL` — that is how §7's two rules coexist in one column.
- `content_revisions` is append-only, same trigger pattern as
  `0001_audit_log_append_only`.

**Media (§24) extends the existing `media` table rather than adding a second
one.** Two image tables means two answers to "what pictures does this project
have". Added: `owner_member_id`, `blob_url`, `pathname`, `mime_type`,
`size_bytes`, `caption`, `credit`, `consent`, `status`, `checksum`. `path` becomes
nullable with `CHECK ((path IS NULL) <> (blob_url IS NULL))` — a row is a repo
asset or a Blob object, never both, never neither. `alt` stays `NOT NULL`; §24
asks for that and the table already believed it.

### A.3 — `0008_moderation` (Phase C)

```
reports              id, reporter_member_id, entity_type, entity_id, reason, details,
                     status ('open'|'triaged'|'resolved'|'dismissed'), moderator_id,
                     resolution, created_at, resolved_at
trust_signals        id, entity_type, entity_id, signal, granted_by, evidence,
                     granted_at, revoked_at, revoked_by
content_fingerprints entity_type, entity_id, fingerprint, created_at
```

- `reports` — partial `UNIQUE (reporter_member_id, entity_type, entity_id) WHERE
  status = 'open'`. One open report per person per thing.
- `trust_signals` carries §19's vocabulary (`claimed`, `identity_verified`,
  `source_verified`, `official_ambassador`, `community_contributor`) and is the
  **only** place verification lives. `granted_by` is `NOT NULL` and references the
  admin `users` table, so a trust signal nobody granted cannot be stored — the
  same argument `ambassadors.verified_via` already makes.
- `audit_log` gains `actor_member_id` (nullable) so a member action can be logged
  without pretending a moderator took it. It stays append-only.
- Rate limiting (§23) reuses the existing pattern: count rows in a window against
  the content table itself. No Redis, no CAPTCHA — for the reasons
  `src/server/submissions/rate-limit.ts` already writes down at length.

### A.4 — `0009_events` (Phase D)

Source data and local enrichment are **different tables**, because §33 is right
and because an ICS-derived event cannot satisfy `events`' `NOT NULL` city, venue
and summary.

```
event_sources          id, source_type ('api'|'ics'|'page'), provider ('luma'),
                       calendar_external_id, organization_id, public_url, api_enabled,
                       webhook_enabled, secret_ref (a NAME, never a key), terms_url,
                       robots_checked_at, trust_level, poll_interval_seconds,
                       enabled, last_synced_at, sync_status, failure_count
external_events        id, provider, external_event_id, canonical_url, source_url,
                       title, description, start_at, end_at, timezone, venue_name,
                       venue_address, lat, lon, city_id, country, online_url,
                       attendance_mode, cover_url, organizer_display_name,
                       registration_status, capacity_status, categories text[], tags text[],
                       source_updated_at, source_hash, first_seen_at, last_synced_at,
                       source_confidence, deleted_at
                       UNIQUE (provider, external_event_id)
event_source_events    external_event_id, event_source_id, first_seen_at, last_seen_at
                       PK (external_event_id, event_source_id)      -- syndication, §31
event_enrichment       external_event_id PK, withclaude_slug UNIQUE, local_summary,
                       featured, city_id, notes, organizer_member_id, community_category,
                       publication_status, moderation_state, updated_by, updated_at
event_sync_runs        id, event_source_id, started_at, finished_at, fetched_count,
                       created_count, updated_count, removed_count, skipped_count,
                       duplicate_count, error_count, error_summary
webhook_deliveries     id, provider, delivery_id UNIQUE, event_type, received_at,
                       processed_at, payload_hash
events.external_event_id   uuid NULL UNIQUE   -- links a curated event to its Luma origin
```

Nothing writes `external_events` except a connector. Nothing writes
`event_enrichment` except a moderator or a verified host. That separation is the
whole reason a re-sync can never silently overwrite a human's summary.

`webhook_deliveries.delivery_id UNIQUE` is §27's idempotency guarantee: a
duplicate delivery is a primary-key conflict, not a duplicate event.

`event_participation` (§48) also lands here: `member_id, event_id |
external_event_id, kind ('attended'|'hosted'|'spoke'|'organized'), state
('declared'|'verified'), verified_by, verified_via`. `declared` is the default and
renders as declared. Nothing infers attendance.

First-party analytics (§38), privacy-conscious by omission:

```
event_click_events   id, event_ref, kind ('cta'|'embed_open'|'outbound'), day date,
                     city_id, created_at        -- no IP, no member id, no user agent
event_daily_metrics  event_ref, day, kind, count       -- rollup, PK (event_ref, day, kind)
```

### A.5 — `0010_graph` (Phase E)

```
member_follows   follower_member_id, entity_type ('builder'|'project'|'city'|'event'),
                 entity_id, created_at    PK (follower_member_id, entity_type, entity_id)
bookmarks        member_id, entity_type, entity_id, created_at
```

`CHECK` that a member cannot follow their own builder record. Counts are derived,
never stored — §20's "avoid a simplistic karma number" applies to follower counts
too, and a denormalised count is a number with no source.

---

## B. Route and rendering changes

The rule: **static stays static; the routes that must reflect a publish within
seconds become dynamic, and they are named.** `output: 'static'` does **not**
change — Astro lets individual routes opt out with `export const prerender =
false`, which is already how `/api/submit` works. No SPA, no global SSR.

| Route | Today | v2 | Why |
| --- | --- | --- | --- |
| `/` | static | **static** + 1 KB stats island → `/api/stats` (CDN 300s) | §44 wants live counters; the homepage is the fastest page on the site and ISR would trade a measured win for a cache miss. Build-time numbers are the no-JS fallback. |
| `/projects`, `/builders`, `/events` | static | `prerender = false`, ISR 60s | §42, §35 |
| `/projects/[slug]`, `/builders/[slug]`, `/events/[slug]` | static | `prerender = false`, ISR 60s | §41 — a new project must have a page with no Git commit |
| `/cities`, `/cities/[slug]` | static | `prerender = false`, ISR 300s | city activity is derived from the above |
| `/discover` | static index inlined | static shell + `/api/search-index` (CDN 60s) | §43 — see B.2 |
| `/stories/*`, `/use-cases/*`, `/guides/*` | static | static until Phase B2/C ships authoring, then ISR 60s | don't pay for dynamism before there is any |
| `/about`, `/community`, `/join`, `/record`, `/404` | static | **static** | no changing record in them |
| `/me/*` | — | SSR, `Cache-Control: private, no-store` | authenticated |
| `/api/*` | 2 routes | SSR, `no-store` | mutations + `/api/me`, `/api/stats`, `/api/search-index` |

`vercel.json` gains `"regions": ["sin1"]` for the public project. It is about to
go from 2 functions to ~25; leaving them in `iad1` while Neon is in
`ap-southeast-1` would add a cross-planet round trip to every one. The admin
already learned this (commit `7edcaad`).

### B.1 — How a dynamic route gets data without rewriting fifty files

The sharpest problem in the migration, so it gets the space.

`src/data/index.ts` exports ~40 **synchronous** selectors over a process-global
memoised `RecordSet`, and fifty files read them as values. Making them async is
the rewrite this abstraction exists to avoid — the file says so itself. But a
process-global is wrong for a server: Vercel Node functions can serve concurrent
requests from one instance, so a plain global swap would let one request render
another's dataset.

So `dataset.ts` gains a request scope, and nothing above it changes:

```ts
const scope = new AsyncLocalStorage<RecordSet>();

export function records(): RecordSet {
  return scope.getStore() ?? buildSnapshot();   // build path: byte-identical to today
}

export function withRecords<T>(set: RecordSet, fn: () => T): T {
  return scope.run(set, fn);
}
```

`src/middleware.ts` (new) wraps dynamic routes only:

```ts
const set = await cachedRecordSet();          // module cache, 30s TTL
return withRecords(set, async () => {
  const response = await next();
  return buffer(response);                    // see the hazard below
});
```

**The hazard, written down because it will bite whoever forgets it:** Astro
streams SSR responses, so component rendering can continue *after* `next()`
resolves — outside the `AsyncLocalStorage` context, where `records()` would fall
back to the build snapshot and silently serve stale data. The response is
therefore buffered inside the scope. That costs streaming on ~10 routes that are
CDN-cached anyway. **A test that fails the naive version is part of Phase B:** two
concurrent requests, two different record sets, neither may see the other's.

Cost, stated honestly: a dynamic route loads the **whole** record set (~110 rows
today) through `loadRecordSet()`, which already exists in `source-db.ts`. With a
30s module cache and 60s ISR in front, that is a handful of queries per minute per
region — cheaper than the alternative, which is forty selectors reimplemented as
SQL and drifting. **This stops being the right trade somewhere around 2–5k
records.** The fix then is targeted queries behind the same selector signatures,
and the equivalence suite is what makes that swap safe. It is not a reason to do
it now.

### B.2 — Search

§43 asks for newly published content to appear quickly while "preserving current
search UI and existing ranking behavior". Postgres full-text search would give
freshness and a **second ranking implementation** — precisely the drift
`search-core.ts` was split out to prevent.

So: keep `search-core.ts` as the only scorer. Move index *construction* to a
server route, `/api/search-index` (CDN 60s), and have the island fetch it instead
of receiving it inlined. Ranking, URL semantics and query parsing are untouched
because they are literally the same code. Revisit Postgres FTS when the index
exceeds ~1 MB gzipped; when that happens it replaces `parseQuery` and candidate
selection only, behind the existing `SearchIntent` seam.

This satisfies §64's two search tests directly: publish → appears; archive → gone.

---

## C. Auth architecture

**Two identity systems, no bridge.** `members`/Privy for the public site;
`users`/better-auth for the admin. A person can be both; the tables never
reference each other except through audit columns (`granted_by`, `resolved_by`),
which record *who moderated*, not *who someone is*.

### C.1 Verification, grounded in the current Privy SDK

Confirmed from Privy's docs (2026-09): access tokens are ES256 JWTs; they can be
stored in an HttpOnly **`privy-token`** cookie; the server SDK is
**`@privy-io/node`** (`verifyAccessToken()`), and it makes a network call to Privy
**unless you supply the verification key** — with the key, verification is local.

That maps onto §4's preference exactly:

- Enable cookie-based sessions in the Privy dashboard. The browser sends
  `privy-token` on same-origin requests to `withclaude.in`.
- The server verifies **locally** with the dashboard verification key (`jose`,
  ES256, checking issuer, `aud = PRIVY_APP_ID`, `exp`). No network hop on the hot
  path.
- Verified `sub` (the Privy DID) → `members.privy_user_id` → upsert on first sight
  (§5) → authorize → mutate.
- A member id, owner id, role, verified flag or moderation state arriving from a
  client is **ignored, not validated**. The only identity input is the token.

One shared `requireMember(request)` in `src/server/auth/member.ts` is the single
door. It returns a member or a 401; there is no second way in.

CSRF: `admin/src/server/origin.ts` already solved this correctly — compare against
the origin actually served, not a canonical env var (commit `61c0f6c`). **Lift it
into a shared module** rather than writing a second one. Plus `sec-fetch-site:
same-origin` where the browser sends it.

### C.2 The client, and the JS budget

§17 wants an auth-aware header; §63 wants minimal client JS. React plus the Privy
SDK is ~150 KB — too much on every static page for an avatar. So it splits:

- **Login UI:** `@privy-io/react-auth` in a React island, `client:only="react"`,
  loaded **only** on `/join` and `/me/*`. This adds `@astrojs/react`, not currently
  a dependency.
- **Every other page:** a ~1 KB vanilla island that fetches `GET /api/me`
  (`no-store`, same-origin) and swaps "Join WITH CLAUDE" for avatar/handle. No
  React, no Privy SDK, nothing blocking. The static HTML ships the
  unauthenticated state, which is what a CDN should cache anyway.

Embedded wallets stay off by default; `member_wallets` fills only when a user
explicitly creates one from their passport (§3).

### C.3 Media upload

Vercel Blob client uploads (§24). `POST /api/media/upload-token` →
`requireMember` → validate declared mime and size → return a token scoped to a
**server-generated** unpredictable pathname. Private store for drafts, public for
published assets. Alt text is required before a media row can attach to published
content — a `CHECK` plus a validation error, not a lint. EXIF is stripped from the
published copy via the `sharp` dependency already present.

---

## D. Event ingestion architecture

I probed the actual sources rather than assuming. What follows is what they really
do.

### D.1 What Luma actually offers

**Official API** — requires **Luma Plus**, and a key is **scoped to a single
calendar you administer** (`x-luma-api-key`, `https://public-api.luma.com/v1`).
Webhooks exist and deliver real event types: `event.created`, `event.updated`,
`event.canceled`, `calendar.event.added`, `calendar.event.submitted`, plus
`guest.*` types **we will not subscribe to** (§32 — no attendee PII). Each webhook
has a `secret` for signature verification.

**The consequence, stated plainly:** the official Claude Community Events calendar
is `cal-TOpA5LAFfuDeFpu` (`luma.com/claudecommunity`) and **we do not administer
it**. Unless Anthropic issues a key, the API and webhook tier is unavailable for
it. Claiming otherwise would be §29's exact warning.

**Public ICS feed** — the good news, and better than scraping.
`https://api.lu.ma/ics/get?entity=calendar&id=<cal-id>` returns `text/calendar`,
200, publicly. For the Claude Community calendar that is **312 VEVENTs, of which
10 are in India** — including two Bhopal events and an upcoming Mumbai one. Per
event it carries:

| ICS field | Value to us |
| --- | --- |
| `UID: evt-XXXX@events.lu.ma` | the Luma event id — **the dedup key** (§31) |
| `SUMMARY`, `DTSTART`, `DTEND` | title and times |
| `GEO:lat;lon` | present on 290/312 — the reliable location signal |
| `DESCRIPTION` | contains the canonical `https://luma.com/<slug>` and the address block |
| `ORGANIZER;CN="Name"` | display name; the MAILTO is a generic `calendar-invite@lu.ma`, so **no PII by construction** |
| `LOCATION` | an address **or** a fallback event URL when the host hides it — §28's "do not assume every location string is reliable", verbatim |
| `STATUS` | `TENTATIVE` on all 312. **Useless.** Must never be mapped to a door state. |
| `SEQUENCE` | identical on all 312. **Useless** for change detection — hence `source_hash`. |
| `REFRESH-INTERVAL:PT12H` | **the publisher's own stated cadence: 12 hours** |

**Public event page JSON-LD** — each event page carries one
`application/ld+json` schema.org `Event`: `url`, `name`, `eventAttendanceMode`
(→ §35's online/in-person filter), `eventStatus` (`EventScheduled` /
`EventCancelled` — a *real* door state, unlike ICS),
`location.address.addressCountry` (**`"IN"` — the authoritative India filter**),
`geo`, and `image[]` cover URLs.

This is structured data a publisher emits *for machines*. Reading it is not DOM
scraping and needs no CAPTCHA bypass, login wall or bot-protection evasion.
`luma.com/robots.txt` carries only a `User-agent: Googlebot` group (disallowing
`/social-share`, `/in/`, `/company/`, `/session-*`) and publishes a sitemap; there
is no rule addressing other agents. **Luma's Terms of Service still need a human
read before the page adapter is enabled** — which is why
`event_sources.terms_url` and `robots_checked_at` exist and why each adapter is
opt-in per source (§30).

### D.2 Three adapters, three honest freshness tiers

| Adapter | Needs | Cadence | Freshness we may claim (§65) | Ships as |
| --- | --- | --- | --- | --- |
| `luma_api` + webhook | Luma Plus + key for a calendar **we administer** | webhook; 10 min poll as backstop | **near-immediate** | written, **no source rows** |
| `luma_ics` | nothing | **60 min** | **within an hour** — and the source itself advertises 12h | **enabled** |
| `luma_jsonld` | nothing | on demand, only for already-discovered events, cached, ≥2 s apart | enrichment only | built, **`enabled=false`** |

**DECIDED (2026-09-09):**

- **ICS is the tier we actually run.** We administer no Luma calendar, so the API
  connector ships with no `event_sources` row pointing at it. It is written and
  tested against a recorded fixture so that the day a key exists — ours or
  Anthropic's for `cal-TOpA5LAFfuDeFpu` — the upgrade is one secret and one row,
  with no code change. Until then the site says "within the hour" and means it.
- **JSON-LD ships disabled.** `enabled=false`, `terms_url` unset,
  `robots_checked_at` unset. Flipping it on is a human decision taken after
  reading Luma's ToS, and the moderation console shows all three fields so the
  person flipping it can see what they are asserting. While it is off, imported
  events have no cover image, no `addressCountry` confirmation and no
  cancellation signal — the India filter runs on `medium` bbox confidence, and
  low-confidence matches queue for a moderator rather than publishing.

**60 minutes, not 15.** The feed advertises `PT12H`. Polling a 12-hour feed every
15 minutes is 48 requests an hour for information that changes twice a day. 60
minutes catches a newly posted event well within the day it appears and does not
pretend the source is faster than it is.

Pipeline: `fetch → parse → India filter → city normalise → upsert by (provider,
external_event_id) → hash-compare → write sync run`. Failure is isolated per
source (`failure_count`, exponential backoff, `enabled=false` after a threshold)
so one blocked calendar cannot stop the others (§30).

**India filter**, in confidence order, recorded in `source_confidence`:

1. JSON-LD `addressCountry == "IN"` → `high`
2. `GEO` inside an India bounding box → `medium`
3. address/description string match → `low`, and **queued for a moderator rather
   than published**

The bbox is a **new `INDIA_BOUNDS` constant, not `src/lib/geo.ts`'s `EXTENT`.**
`EXTENT` is cropped tight to the plotted cities (68–95.5°E, 7–34.5°N) because a
survey sheet is cropped to its subject; reusing it as a geofence would silently
drop real events in Arunachal (to 97.4°E) and Ladakh (to 37°N). A cartographic
choice must not become a data filter.

**City normalisation:** nearest of the 14 known cities within 60 km using the
existing `distanceKm()`. No match → the event is stored with `city_id NULL` and
surfaces in moderation. **A connector never creates a city.** `cities` feeds §1's
derived city state, and an auto-created city is an auto-created chapter.

**Registration status** comes from JSON-LD `eventStatus` or the authorized API,
never from ICS `STATUS`. Absent both, the field stays `NULL` and the page says
nothing rather than guessing.

### D.3 Scheduler

**DECIDED (2026-09-09): the Cloudflare Worker.** `with-claude` is on the Vercel
Hobby plan, where cron is once-daily, so §40's external worker is required rather
than preferred. `vercel.json` keeps its one daily rebuild cron.

The Worker's only job is the schedule. It calls the same `syncSource()` module the
webhook route calls, so the scheduler stays swappable and nothing about the
ingestion logic knows which trigger woke it. The app does **not** move to
Cloudflare (§40).

### D.4 Registration, embed, UTM

`/events/[slug]` → **Register** → Luma's official embed overlay, with the direct
"Register on Luma" link as fallback (§37). We never reproduce Luma's checkout.
Outbound URLs get `utm_source=withclaude`, `utm_medium=event_page`,
`utm_campaign=claude_community_india`, `utm_content=<city-or-slug>`.

What we can honestly promise a host: **attribution**, plus our own first-party
counts of CTA clicks, embed opens and outbound clicks. Not their registration
numbers — unless they own the calendar and authorize a key (§39).

Embeds load from expected Luma origins only, via an explicit allowlist (§56). No
generic iframe system. All external text is escaped; no source HTML reaches
`set:html` (§55).

---

## E. Migration strategy

The precondition nobody should skip: **production still renders from
`DATA_SOURCE=ts`.** Every dynamic route in v2 reads the database. So step zero is
flipping the source, and that is a change with its own verification, taken before
any v2 feature exists.

### E.0 — Phase 0 findings, run 2026-09-09

`npx vitest run tests/equivalence-neon.test.ts` against production Neon:
**25 passed, 10 failed.** The database is not equivalent to the TypeScript record,
so **the flip cannot be taken yet.** All ten failures trace to one cause.

Neon holds **73 published builders; `src/data/builders.ts` holds 71.** The two
extra rows are real, fully audited records created through the legitimate
`/api/submit` → promote → publish pipeline:

| Slug | Name | City | Created | What it is |
| --- | --- | --- | --- | --- |
| `prod-test-builderprod-test-builder` | Prod Test BuilderProd Test Builder | ahmedabad | 2026-09-06 | self-described production pipeline test — `building: "Testing production submission pipeline with Neon DB."` |
| `punit` | Punit | delhi | 2026-09-08 | looks genuine — `role: "Web3 dev"`, `building: "Bloopa.xyz"` |

Both are `status = published` with two audit rows each. **Flipping
`DATA_SOURCE=db` publishes both to the live site.** Resolving them is a data
decision for the owner, not a code change, and §69 forbids me touching either
unasked.

Two things the doubled name is **not**: it is not a promotion bug. The retained
payload carries `"name": "Prod Test BuilderProd Test Builder"` and
`submitter_name` matches, so the doubling arrived from the form input.
`slugify(name)` then did exactly its job.

Two things it **is** — both real, and both requirements this design gained from
looking:

1. **Claude surface names are free text and are not normalised.** `punit` carries
   `claudeTools: ["Claude code"]` (lower-case `c`) where the TypeScript record
   uses `"Claude Code"`. That single row is why `claudeSurfaces()` returns
   `['Claude code']` from the database and `[]` from TypeScript. With 71 curated
   records this is a typo; with self-publishing it fragments the practice library
   into `Claude code` / `Claude Code` / `claude-code`. **Phase B therefore
   normalises Claude stack values against a controlled vocabulary at write time**,
   with anything unrecognised stored as a free tag rather than a surface.
2. **Submitted URLs are stored without a scheme.** `punit`'s payload has
   `links: "Impure.me"`. §23 requires HTTPS-only URL validation; Phase B's project
   and profile validators must normalise and reject rather than store what was
   typed.

### E.0.1 — Resolved, 2026-09-09

The owner decided both records, and the two decisions were carried out.

**`prod-test-builderprod-test-builder` — archived, not deleted.** Taken down
through `transitionContent()`, the same function the admin's Archive button
calls, so it got the checks that path guarantees: role first, `published →
archived` on the map, a required note, and the audit row and status change in
one transaction. Its two existing audit entries survive and a third was added:

```
2026-09-06  promoted          null → approved
2026-09-06  builder.published approved → published
2026-09-09  builder.archived  published → archived
```

**`punit` — kept published, transcribed into `src/data/builders.ts` verbatim.**
`claudeTools: ['Claude code']` and `links: [{ label: 'impure.me', url:
'https://impure.me/' }]` are copied exactly as the database holds them. Neither
was tidied: correcting them would make the sources disagree, which is the one
thing the entry exists to prevent, and would edit somebody's description of
their own work to smooth a comparison. No `owner_member_id` was inferred — the
Privy claim flow is how that gets set, and a matching name is not proof (§6).

**And one real defect the archive exposed, fixed in the reader.** Archiving the
row did not remove it from the record set: `loadRecordSet()` reads `builders`
past the publication predicate on purpose, so a `pending` builder's *name* can
still appear as a credit. That exception was written for `pending` and was
silently covering `archived` too — so an archived builder stayed loaded, their
name could still resolve through `builderNamesOf()`, and the TypeScript source
could never agree with the database again, because a takedown is not a thing a
version-controlled file can represent.

`publishing.ts` already promises the opposite: "the row stays, the audit trail
stays, and the public reader simply stops selecting it." `source-db.ts` now
excludes `WITHHELD_BUILDER_STATUS` from that one exception, which makes the
promise true. **The equivalence suite was not touched** — the reader was wrong,
not the test.

`scripts/compare-builds.mjs` was also hardened. Pointed at `dist/client` rather
than `dist` it found no HTML, every check passed trivially, and it printed
"EQUIVALENT — routes, HTML and sitemap all match" under a line reading
`ts=0 db=0`. It now exits 2 rather than claiming a pass it did not earn.

**Verification, all green** (`npx tsx scripts/verify-phase0.mjs`):

| Check | Result |
| --- | --- |
| Neon equivalence suite | **35/35 pass** (was 25/35) |
| Full test suite | **539/539 pass** |
| `DATA_SOURCE=ts` vs `db` build | 72 routes each, **72/72 byte-identical HTML**, 60 sitemap URLs each |
| Builder rows | 69 `pending` + 3 `published` + 1 `archived` = 73; **72 reach the record set** |
| Published public set | `aniket-sahu`, `vishal-kumar`, `punit` — identical in both sources, same order |
| Projects / events / cities / ambassadors | 26 / 14 / 14 / 1 — unchanged |

**Production `DATA_SOURCE` is deliberately still `ts`.** The flip is verified as
safe but has not been taken; it is the owner's to make.

```
0.  branch `v2-user-platform`; Neon branch `v2-preview` for the preview DB
1.  run the existing equivalence suite against production Neon      (it exists)
2.  DATA_SOURCE=db on Preview → verify 71/26/14/14 and diff the built HTML
3.  DATA_SOURCE=db on Production. Rollback = one env var, unchanged.
4.  0006 → Phase A on Preview → 0007 → Phase B → … one migration per phase
5.  after each: record-count assertion + `npm test` + a Preview smoke pass
```

Rules that hold throughout:

- **`src/data/*.ts` is not deleted** (§58). It stays the rollback path and the
  migration history. It simply stops *gaining* rows (§59): after Phase B, new user
  content exists only in Neon, and `source` says which is which.
- Legacy records are `source='legacy'`, `owner_member_id=NULL`. A claim **links**;
  it never copies and never rewrites authorship (§7, §11).
- **§69 is a hard rule with a test.** Fixtures are created, prefixed `zz-test-`,
  and live only on the Preview Neon branch. No existing person or project is ever
  archived, published or edited to exercise an admin action. The fixture helper
  gets a guard that refuses to run against a `DATABASE_URL` whose host matches
  production.

---

## F. What you must configure manually

Values go in the places named. **Do not paste secrets into chat.**

### Privy — dashboard (`dashboard.privy.io`)
1. Create/confirm the **production** app; note the App ID.
2. Allowed domains: `withclaude.in`, `www.withclaude.in`, `*.vercel.app` (preview),
   `localhost:4321`.
3. Login methods — enable **only** what you want live: email, Google, GitHub,
   LinkedIn, X, wallet.
4. **Enable cookie-based sessions** (this design depends on the `privy-token`
   cookie).
5. Embedded wallets: **off / user-initiated only**.
6. Copy the **verification key** (for local ES256 verification).

### Vercel — `with-claude` project → Settings → Environment Variables
| Name | Scope | Notes |
| --- | --- | --- |
| `PUBLIC_PRIVY_APP_ID` | Production + Preview | the only Privy value the browser may see |
| `PRIVY_APP_ID` | Production + Preview | server |
| `PRIVY_APP_SECRET` | Production + Preview | server only, never `PUBLIC_` |
| `PRIVY_VERIFICATION_KEY` | Production + Preview | enables local verification |
| `BLOB_READ_WRITE_TOKEN` | Production + Preview | created by adding a Blob store |
| `DATA_SOURCE` | Production + Preview | set to `db` at step 3 above |
| `DATABASE_URL`, `DATABASE_URL_READONLY` | already set | — |
| `LUMA_API_KEY_<CALENDAR>` | Production | **only** for a calendar you administer |
| `LUMA_WEBHOOK_SECRET_<CALENDAR>` | Production | per webhook |

Also: **Storage → create a Blob store** and connect it to this project. Adding
`"regions": ["sin1"]` to the root `vercel.json` is a code change and I will do it.

The **admin** project's environment is untouched. better-auth stays.

### Luma — only if you want the near-immediate tier
1. Luma Plus on an account that **administers** a calendar.
2. An API key per calendar (Settings → API).
3. A webhook pointing at
   `https://www.withclaude.in/api/integrations/luma/webhook`, subscribed to
   `event.created`, `event.updated`, `event.canceled`, `calendar.event.added` —
   **not** the `guest.*` types.
4. Putting the official Claude Community calendar on the API tier is a request to
   Anthropic for a key. Without it we are on the 60-minute ICS tier, and the site
   will say so.
5. Read Luma's Terms of Service and tell me whether to enable the page/JSON-LD
   adapter. I will not enable it on my own reading of robots.txt alone.

### Cloudflare Worker — required (Vercel is on Hobby)
Phase D, not before. A Worker with an hourly cron trigger, plus `DATABASE_URL`
and `SYNC_SHARED_SECRET` as Worker secrets. I will write the Worker and its
`wrangler.toml`; creating the Cloudflare account/worker and pasting the two
secrets is yours.

### Resend — Phase F, not before
Verified sending domain, production key, from address. Notifications are opt-in
and stay off the publish path (§49).

### Answered, 2026-09-09
- **Vercel plan:** Hobby → Cloudflare Worker for polling (D.3).
- **Luma calendars:** none administered → ICS tier only; API connector written but
  wired to nothing (D.2).
- **Luma ToS:** unread → JSON-LD adapter built and shipped `enabled=false` (D.2).

### Still outstanding
- **Phase 0's remaining step:** set `DATA_SOURCE=db` on Preview, then Production.
  The equivalence is verified (E.0.1); taking the flip is yours. Rollback stays
  one environment variable.
- Read Luma's ToS, then enable the `luma_jsonld` source row if it permits.
- If you want the near-immediate tier for the official Claude Community calendar,
  that is a request to Anthropic for an API key.

---

## G. Implementation phases

Each phase is a shippable branch with its own migration, tests and Preview
verification. §14's staging is respected: Builder + Project first, stories and
use-cases after, guides last.

**Phase 0 — source flip.** `DATA_SOURCE=db` in production, equivalence verified,
`regions: sin1`. No new features. This is the riskiest change in the plan and it
ships alone. *Tests:* existing equivalence suite green against Neon; record counts
71/26/14/14.

**Phase A — identity.** `0006`. Privy island on `/join`, `requireMember`, shared
origin module, `/api/me` + header island, Builder Passport steps 1–9, `/me`,
`/me/profile/edit`, `/me/settings`, claim flow with auto-resolve on strong proof
and a moderation queue for everything else. *Tests:* §64's Privy and profile
lists, including duplicate-claim prevention and the ambiguous-claim path.

**Phase B — self-publishing.** `0007`. `publicationOf()` and the `isPublic()`
change; `/me/projects{,/new,/[slug]/edit}`; Blob upload tokens; `project_members`
permissions; `content_revisions`; the dynamic-route dataset scope; the
`/api/search-index` move. *Tests:* the concurrency test for `withRecords`, edit
another member's project → 403, the collaborator matrix, publish → visible with no
Git commit, archive → gone from search.

**Phase C — moderation.** `0008`. `reports` plus a Report control on every entity;
the admin becomes `/moderation`, `/reports`, `/content`, `/users`, `/audit`;
archive / restore / restrict / soft-delete, each requiring a reason and writing an
audit row in the same transaction — reusing `transitionSubmission`'s pattern,
which already gets this right. `trust_signals`. *Tests:* every action writes
exactly one audit row; no silent state change is reachable; soft delete never
removes a row.

**Phase D — events.** `0009`. Source registry, the three adapters, the webhook,
the India filter, city normalisation, `/events` sections and filters,
`/events/[slug]` with the Luma embed, UTM and "last synced", and moderator source
management. *Tests:* dedup by UID, syndication across two calendars, `TENTATIVE`
never becomes a door state, `source_hash` change detection, webhook idempotency,
and the 10 real India events from the live feed as a recorded fixture.

**Phase E — discovery.** `0010`. Follows, bookmarks, the following feed, the
public Builder Passport, the build graph over Postgres relations, city
intelligence.

**Phase F — growth.** Organizer analytics, reminders, notifications via Resend,
badges derived from audit/machine evidence only, share cards.

---

## What this design refuses to do

Written down so it can be held to:

- No second public app, no `events.` or `community.` subdomain (§57).
- No approval step for ordinary publishing (§72). `pending`/`approved` survive only
  for the legacy submission inbox.
- No "real-time" claim for a source that polls. The ICS tier is hourly and the page
  will say `Last synced N minutes ago` (§65).
- No unrestricted scraping. Three named machine-readable surfaces, opt-in per
  source, rate-limited, terms read by a human (§29).
- No self-assignable verification. `trust_signals.granted_by` is `NOT NULL` (§19).
- No hard delete in the ordinary UI (§12).
- No deletion of `src/data/*.ts` (§58).
- No production content touched to test an admin action (§69), enforced by a
  fixture guard that refuses the production host.
