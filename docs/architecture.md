# WITH CLAUDE — architecture

The canonical developer reference. `docs/architecture-v2.md` is the older
proposal document and is kept for its reasoning; where the two disagree, this
file is what the code does.

> WITH CLAUDE is a living directory and community platform for people,
> projects and events around Claude in India.

Three public pillars — **builders**, **projects**, **events** — plus **cities**
as a discovery layer and **practice** as a secondary one.

---

## 1. The stack, and what is deliberately absent

| Concern | Choice |
|---|---|
| Public web | Astro 5 + TypeScript, `output: 'static'` |
| Interactive UI | React, islands only |
| Database | Neon PostgreSQL (`ap-southeast-1`, Singapore) |
| ORM / migrations | Drizzle + `drizzle-kit` |
| Member identity | Privy |
| Admin staff identity | Better Auth, in `admin/` |
| Media | Vercel Blob |
| Email | Resend |
| Hosting | Vercel, functions pinned to `sin1` |
| Scheduled work | Vercel Cron |
| Event source | Luma — public iCal feed |

There is no Redis, no Algolia, no Baserow, no Supabase, no second framework and
no custom session layer. Search is one ranking implementation
(`src/lib/search-core.ts`). Adding any of these is a decision to be argued for,
not a default.

### Static first, and still static

`output: 'static'` means every page is a file on a CDN unless it explicitly
opts out with `export const prerender = false`. The set of on-demand routes is
**enumerated in a test** — `tests/admin-isolation.test.ts` fails until a new
dynamic route is written down there. That is what stops the archive drifting
into an application one convenient route at a time.

Two rules keep credentials away from the browser, both enforced by that suite:

- A **prerendered** route must never import `db/client`, `db/pool` or
  `db/schema`. A route declaring `prerender = false` may.
- No `.astro` page imports a database module at all. `src/server/http/page-guard.ts`
  opens the one connection and hands it down.

---

## 2. Data: Neon is the source of truth

`DATA_SOURCE` selects where the public record is read from:

- `ts` — the authored TypeScript in `src/data/*.ts`. The rollback path.
- `db` — PostgreSQL. **What production runs.**

The seam is deliberately low. A source's whole job is to produce one
`RecordSet` (`src/data/source.ts`) — eight record arrays in the shapes
`src/data/types.ts` already defines. All ~40 selectors in `src/data/index.ts`
sit above it and are written once, so "the two sources agree" is checked by
comparing one value rather than forty pairs of functions
(`tests/equivalence.test.ts`, `tests/equivalence-neon.test.ts`).

`db/snapshot.ts` runs in `prebuild` and reads the database **once**, before
`astro build`. The render path reads that snapshot.

---

## 3. Identity

```
browser → Privy → access token → server verification → member row in Neon
```

`src/server/auth/privy.ts` is the only file that turns a credential into an
identity. It returns the Privy DID and nothing else, so no caller can
accidentally trust a name, email or role that arrived inside a token.

### What verifies a token

`verifyAccessToken()` from `@privy-io/node`. Its `verification_key` is typed
`CryptoKey | JWTVerifyGetKey | string` — the key, or a mechanism to fetch it.
Both are supported:

- **`PRIVY_VERIFICATION_KEY` set** → static PEM, local ES256 check, no network.
  Preferred.
- **not set** → the app's published JWKS via `createRemoteJWKSet`, cached per
  app id at module scope.

The JWKS path is not a workaround. This app's JWKS publishes **two** ES256
signing keys and nothing outside the Privy dashboard says which is current, so
a pinned PEM is a coin flip; a JWKS resolver selects by the token's `kid` and
survives rotation. An **empty** `PRIVY_VERIFICATION_KEY` is treated as absent —
`vercel env pull` writes an unset variable as `KEY=""`, and treating that as
configured is what previously made every authenticated request answer 503.

`PUBLIC_PRIVY_APP_ID` is never read server-side. It is the browser's copy, and
a server-side security check must not depend on a value Astro inlines into a
bundle.

### Login UX

`PrivyRoot.tsx` is mounted **once** for the whole site, from `AccountNav.astro`
via `Masthead.astro`, and portals its UI into named DOM nodes. A second
`PrivyProvider` on a page is the hydration-loop bug this island exists to
avoid. Clicking **JOIN WITH CLAUDE** opens the Privy modal in place — there is
no `/join` navigation and no login page.

### `/me/*` when signed out

The account pages do **not** redirect. `guardPage()` returns one of five
reasons and `AuthRequired.astro` renders the matching state at the requested
URL, so login returns the visitor to the page they asked for:

| reason | shown |
|---|---|
| `unauthenticated` | "Sign in to continue" + Privy CTA |
| `server-not-configured` | "Sign-in temporarily unavailable", no CTA |
| `no-member` / `profile-required` | "Setting up your account" |
| `member-unavailable` | "Account not available", no CTA |

Keeping `server-not-configured` distinct matters: collapsing it into
`unauthenticated` is what showed a sign-in button to users who were already
signed in.

### Model

`members` (Privy DID, status) → `member_identities` (verified linked accounts,
`(provider, provider_subject)` unique) → `member_profiles` (what the member
edits). The **published** profile lives in `builders`, written by one
whitelisting projection — so editing a bio cannot reach `name`, `roles`, an
ambassador link or a historical event credit.

---

## 4. Projects

`draft → published → archived → deleted` in `publication_status`, and
`clean → reported → restricted → archived → removed` in `moderation_state`.
**Two columns, never one.** Publishing is an editorial act; restricting is a
moderation act; folding them together is what made the original enum lossy.

Public visibility requires `publication_status = 'published'` **and**
`moderation_state = 'clean'`.

Ownership is `projects.owner_member_id` and nothing else. `project_members`
carries collaborators only and its enum is `collaborator | contributor` with no
`owner` — an owner recorded twice is two records that can disagree.

**Publishing is instant.** No admin approval (§13). The gate is completeness,
not permission: `publishBlockers()` in `src/server/members/projects.ts` requires
a title, a summary and a city, because `Project.citySlug` is a required string
that prerendered pages dereference without a null check. Migration 0010 made
those columns nullable so a *draft* can be saved — before it, every project
creation inserted `NULL` into a `NOT NULL` column and failed at the database.

`src/data/source-db.ts` filters incomplete published rows out as a backstop and
logs them, rather than throwing and failing the whole build for one bad row.

### Freshness — stated precisely

- `/projects/[slug]` is **SSR**. A newly published project is live immediately.
- `/projects/` (the listing) and the search index are **prerendered**. They pick
  it up at the next build, which the nightly rebuild guarantees.
- `/sitemap.xml` is **SSR**, read live from Neon.

The publish response says so explicitly (`detailLive`,
`listingRefreshesOnNextBuild`) rather than letting the UI imply "instant"
everywhere.

---

## 5. Media

```
browser → POST /api/media/upload (authorise) → short-lived token
browser → Vercel Blob (direct upload)        → bytes never touch our function
Blob    → onUploadCompleted                  → row in `media`
```

Authorisation happens in `onBeforeGenerateToken` and **only** there. By the
time `onUploadCompleted` runs the bytes are already stored, so a check there
decides whether to *record* an upload, not whether to *permit* it. The client
payload names a `projectId` and the route verifies the caller may edit it using
`canEditProject()` — the same check the edit and publish routes use.

Stored in `media`: `owner_member_id`, `project_id` (migration 0011),
`blob_url`, `pathname`, `mime_type`, `size_bytes` (from Blob, not from the
client), `alt` (NOT NULL), `caption`, `status`. Uploads land `staged`: an
upload is not a publication. Allowed types are an explicit list —
`image/svg+xml` is excluded because an SVG is a scriptable document served to
browsers.

---

## 6. Events and Luma

The largest ingested system, and the one where honesty about mode matters most.

### Mode: ICS. Not realtime.

We do **not** administer the Claude Community calendar and hold no API key or
webhook secret for it. What runs is a **scheduled fetch of a public iCal feed**:

```
https://api.lu.ma/ics/get?entity=calendar&id=cal-TOpA5LAFfuDeFpu
```

Two non-obvious facts about that URL:

1. The `id` must be the calendar's internal `api_id` (`cal-…`). The public slug
   returns **404**. The api_id is readable once from the calendar page's HTML.
2. The host must be `api.lu.ma`. `lu.ma/ics/get?…` returns **200 with HTML**,
   which a parser reads as a calendar of zero events — a failure that looks like
   success, and which would mark every event withdrawn. `LumaIcsSource` rejects
   a non-calendar body and an empty calendar for exactly this reason.

`GET /api/health` reports `events.mode` and `events.realtime` (always `false`),
derived from configuration rather than written by hand.

### The abstraction

`EventSource` (`src/server/events/source.ts`) has one job: fetch, and return
`NormalizedEvent[]`. It does not classify, resolve cities, decide publishability
or touch the database — all of that is `sync.ts`, once, for every source.

- `LumaIcsSource` — the public feed. **Running.**
- `LumaApiSource` — `create()` returns `null` without `LUMA_API_KEY`. Inert.
- `ManualEventSource` — in-memory; also what the webhook and the tests use.

`FetchResult.complete` is the most dangerous field in the system. `sync.ts`
treats an event absent from a **complete** fetch as withdrawn, because for this
feed absence is the *only* cancellation signal — it reports `STATUS:TENTATIVE`
on all 317 of its events. So a paginated fetch or a one-event webhook **must**
set `complete: false`, or it cancels everything it did not mention.

### Ingestion lands in a staging table

Ingested events do **not** go straight into `events`. That table is the curated
public record the whole `RecordSet` reads, and its `NOT NULL`s (`city_id`,
`venue_name`, `summary`, `format`) are why prerendered pages need no null
checks. A feed cannot honour them.

`event_source_records` holds every external event ever seen, normalised, with
its classification and state:

| state | meaning |
|---|---|
| `promoted` | in India, city resolved — present in `events` |
| `review` | cannot be confidently placed. **Not published.** Kept for a human |
| `rejected` | confidently not in India |
| `withdrawn` | vanished from the feed, or cancelled at source |

`(source_id, external_id)` is a unique index — **that** is the idempotency
guarantee, not the control flow. `raw_hash` is a SHA-256 of the fields that
would change what a visitor sees, excluding `DTSTAMP`/`SEQUENCE` which Luma
bumps on every export; an equal hash means the row is skipped entirely.

### The India filter

The Claude Community calendar is a **world** calendar: 317 events, 13 of them in
India. Signals, in order of trust:

1. an explicit country in `LOCATION` — conclusive (100)
2. `Asia/Kolkata` timezone — conclusive (95)
3. **coordinates within 75 km of a known Indian city centre** — conclusive (100)
4. an Indian state (40) or city name (35) — corroborating
5. coordinates merely inside the India bounding box (45) — corroborating only

Threshold to publish unreviewed: **80**.

Signal 3 exists because of a real failure. Eleven genuine Indian events —
including **three in Bhopal**, this community's own city — publish their address
as a bare Luma URL because the venue goes to registrants only. They carry no
country, no state and no city name; only `GEO`. Scored on the bounding box
alone they sat at 45 and went to review, which quietly emptied the most active
chapter out of the directory. Proximity to a known city centre is conclusive
where a box is not, because no non-Indian city is within 75 km of any of those
points — and it also *names* the city for an event whose text never did.

A title is never used to decide location (§21): the two Indian events with real
addresses happen to be titled "Mumbai | …" and "Bangalore | …", but
`Hyderabad House, Washington` is a restaurant in the United States.

A confidently-Indian event whose city is **not** one of the curated fourteen is
`review`, not `rejected` — Puducherry is the live example. It is a real event
with nowhere to live yet, so it waits for a human.

### Deduplication against the curated archive

The curated events were authored from this same calendar, so some of them *are*
feed events — measured live, two: `claude-code-for-builders` and
`claude-impact-lab-september`. Matching is by registration URL reduced to
host + path (query discarded, because our own outgoing links carry UTM). A
match **links** the staging row to the authored event and writes nothing to it:
the authored version has a real venue, a real summary and an ambassador credit
that the feed lacks.

A curated event has `source_id IS NULL`, and every write in `promote()` and
`withdrawEvent()` is scoped by `source_id` — so a feed **cannot** rename,
reschedule or cancel an event a person wrote.

### Cancellation

`canceled_at` is set and `status` moves to `archived`; the row is never deleted,
because an event that happened still happened. `status_override = 'cancelled'`
feeds the existing `lifecycleOf()` / `isRegistrationOpen()` logic, so the page
stops advertising a door that will not open.

### Performance

The first implementation did one round trip per event: 317 sequential
statements, **35 seconds** measured — against a `maxDuration` of 15. It was
correct-looking and could never have finished in production. `syncSource()` is
now phased: classify in memory → one `UPDATE` for the unchanged majority →
chunked multi-row upserts for what changed → per-event writes for the ~12
promotions. Steady state is **2.3 s**.

The multi-row upsert sets from `excluded.*`. Writing literal values there would
apply the last row of a 50-row batch to every conflicting row in it.

### UTM

`registrationLink()` in `src/lib/attribution.ts` adds
`utm_source=withclaude&utm_medium=event&utm_campaign=india-community` — and
**never overwrites** a parameter the source already set, so an organiser
circulating their own `utm_source` keeps their attribution. Non-`http(s)`
schemes are refused, since this value originates in an external feed.

The JSON-LD `offers.url` stays **undecorated**: that field is a canonical
identifier, not a click.

---

## 7. Moderation and audit

Admin is **not** a publishing gate. Members publish instantly; moderators act
reactively — dismiss, restrict, restore, archive, soft-delete.

Every moderator mutation writes to `audit_log`, which is **append-only**: a
trigger from migration 0001 refuses every `UPDATE`. A consequence worth
knowing: a member who has ever acted cannot be hard-deleted, because nulling
`actor_member_id` is an `UPDATE` and the cascade fails. A member is retired by
setting `members.status = 'deleted'`. That is the database enforcing the rule
rather than everyone remembering it.

A scheduled sync writes audit rows with **both** actor columns null — a cron job
is not a person, and the table permits that deliberately.

---

## 8. Admin

Separate Astro app in `admin/`, deployed to `admin.withclaude.in`, Better Auth
over a `users` allowlist, pinned to `sin1`. Same-origin is checked against the
**served host**, never `BETTER_AUTH_URL`. Two identity systems, no bridge:
neither can mint or read the other's session.

---

## 9. Scheduled work

`vercel.json`, both **daily** — Hobby runs cron daily only, and an hourly
expression there does not produce hourly runs:

| path | UTC | why |
|---|---|---|
| `/api/cron/events-sync` | `45 21` | fetch and reconcile the feed |
| `/api/cron/rebuild` | `30 22` | deploy hook, so prerendered pages see it |

Order matters: writing an event to Neon does not put a page on the CDN. Sync
first, rebuild 45 minutes later. The feed itself advertises
`REFRESH-INTERVAL:PT12H`, so daily is well within what it asks for.

Both routes require `Authorization: Bearer $CRON_SECRET`. **No secret
configured is a 503, not a bypass** — an open endpoint that hammers a
third-party feed and writes to production is not something to leave open
because a variable was forgotten.

---

## 10. Environment

Required in production:

| variable | notes |
|---|---|
| `DATABASE_URL` | Neon, pooled |
| `DATA_SOURCE` | `db` |
| `SUBMISSION_IP_SALT` | submission rate limiting |
| `CRON_SECRET` | both cron routes refuse without it |
| `PUBLIC_PRIVY_APP_ID` | browser; without it Privy cannot initialise |
| `PRIVY_APP_ID` | server; must be the same app |
| `RESEND_API_KEY`, `RESEND_FROM` | transactional mail |
| `VERCEL_DEPLOY_HOOK_URL` | nightly rebuild |

Optional: `PRIVY_VERIFICATION_KEY` (JWKS fallback otherwise),
`PRIVY_APP_SECRET` (only for SDK calls that need it), `LUMA_*` (all default to
the public feed), `BLOB_READ_WRITE_TOKEN` (injected when the store is
connected).

`GET /api/health` reports every one of these as a **boolean** — never a value,
a prefix or a length. It also reports database reachability, latency, region,
and per-source sync freshness, because a feed that stopped parsing three weeks
ago looks exactly like a quiet community until someone checks `lastSyncedAt`.

---

## 11. Migrations

`drizzle-kit generate` writes SQL into `db/migrations`, which is committed;
`npm run db:migrate` applies it. Nothing pushes a schema straight at a
database, so the schema can always be rebuilt from empty — and
`tests/db.test.ts` proves it, applying every committed migration to a fresh
PGlite (real PostgreSQL in WASM, so the CHECK constraints and triggers are the
real ones).

Migrations are **additive first**. 0010 and 0011 drop `NOT NULL` and add
nullable columns and new tables; nothing is dropped or rewritten, so no
existing row can be invalidated. Production carried 75 builders, 27 projects,
14 events and 39 audit rows through both with every count unchanged.

Existing community records are real data. They are not normalised, rewritten or
deleted to make a test pass.

---

## 12. Security

- Server-side authorisation for projects, media, profiles, claims, reports and
  moderation. `canEditProject()` is the single answer to "may this member touch
  this project"; four routes previously inlined four copies of it.
- `guardMutation()` runs six checks in a fixed order — method, same-origin,
  content type, body size, identity, schema — so a new route cannot skip step
  2, which is how CSRF bugs usually arrive. `/api/media/upload` cannot use it
  (Blob parses its own body) and therefore performs the origin and identity
  checks explicitly, with a comment naming what it is substituting for.
- Zod schemas are `.strict()`: sending `ownerMemberId` is a 422, not a
  silently-ignored field.
- Member-supplied URLs are scheme-checked. `z.string().url()` alone accepts
  `javascript:`, and these render as `href`s.
- "Not found" and "not yours" are the same 404, so ids cannot be enumerated.
- No token in a URL, ever — a URL reaches history, `Referer` and access logs.
- `verifyRequest()` logs nothing from a failure. Privy's errors can carry the
  token.
- `/api/health` and cron routes reveal no values.
- `.gitignore` covers `.env.*` with `!.env.example`. `.env.preview.local`, which
  `vercel env pull` writes, was previously untracked-but-committable with live
  credentials in it.

---

## 13. SEO

Public pages carry canonical URL, title, description, OG data and structured
data. `/me/*`, `/admin/*` and `/api/*` are `noindex`.

`/sitemap.xml` is SSR and reads Neon directly, so a newly published project or
profile appears without waiting for a build. It enumerates only public routes,
filtered on the same predicates the pages use — projects on
`published` + `clean`, builders on `published` + `clean|reported`, events on
`published`, cities via `indexableCityPaths()`.

`isPrivatePath()` in `src/lib/indexable.ts` is a **prefix** rule covering `/me/`
and `/api/`. It is a prefix rather than a list because the six account pages
were not omitted from the old sitemap through carelessness — nothing connected
adding an account page to updating a sitemap rule, so a list of six would be
forgotten again by the seventh.

A city with nothing in it gets a real page (a visitor who clicks a dot should
land somewhere honest) but not a sitemap entry.

---

## 14. Performance

Public pages stay static. Functions are pinned to `sin1`, beside Neon in
Singapore. Account pages are SSR with `Cache-Control: private, no-store` — a
page naming its reader must never enter a shared cache.

Known N+1: `getProjectData()` in `src/server/directory.ts` loops a builder
lookup per row. It is bounded and on an SSR path, and it is the next thing to
fix there.
