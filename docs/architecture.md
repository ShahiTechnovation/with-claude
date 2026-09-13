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
`utm_source=withclaude.in&utm_medium=event&utm_campaign=india-community` — and
**never overwrites** a parameter the source already set, so an organiser
circulating their own `utm_source` keeps their attribution. Non-`http(s)`
schemes are refused, since this value originates in an external feed.

The canonical source value is the **domain**, exactly: `withclaude.in`. It was
`withclaude` until the unification pass, which is the kind of difference that
does not look like a bug and behaves like one — an organiser reading their Luma
referrer report saw two sources where there was one, and neither total was the
real number of people this site had sent them. `withclaude`, `WITHCLAUDE` and
`with_claude` are not accepted or aliased anywhere; `tests/utm-attribution.test.ts`
asserts the literal string rather than importing the constant, because a test
that reads the value it is checking cannot catch that bug.

Luma registration **embeds** never pass through a URL we build, so they carry
the same value through Luma's own mechanism: `lumaEmbedAttributes()` returns
`data-luma-utm-source` and friends, read from the same `UTM` constant. WITH
CLAUDE does not become the registration provider — the default path is a link
to Luma, and an embed is an enhancement on an event that supports one.

The JSON-LD `offers.url` stays **undecorated**: that field is a canonical
identifier, not a click.

---

## 6a. Ambassadors, host attribution and the activity index

### One graph, not a second one

An ambassador is an extension of the existing record, not a parallel system.
`ambassadors` already existed and already linked to `builders`; the
unification pass added an identity a source can be matched against and a
relationship that can carry a role.

```
Privy ─▶ members ─▶ member_profiles ─▶ builders ─┐
                                                  ├─▶ ambassadors ─▶ event_hosts ─▶ events ─▶ cities
                                     Luma ─▶ event_sources ─▶ event_source_records ─┘
```

`ambassadors.member_id` links to a claimed account, `ambassadors.builder_id` to
the public profile. Neither copies anything: the bio, city and projects on an
ambassador page are read through those joins, so there is no second profile to
keep in step.

### `event_hosts` is canonical; `events.ambassador_id` is a denormalisation

`events.ambassador_id` records one host and nothing about them — no role, no
provenance, no confidence. Enough for the verified treatment on an event page,
not enough for a credit. So attribution lives in `event_hosts`
`(event_id, ambassador_id, role, source, confidence)`, and the column stays as
a denormalisation of that table's single `primary_host` row, because
`RecordSet`, `cityState()` and the prerendered pages read it with no null
checks.

The invariant:

```
events.ambassador_id  ==  the ambassador_id of that event's single
                          primary_host row in event_hosts, or NULL
```

Two writes that must not diverge is the shape of bug that gets written when two
modules each do half of it, so **every** mutation in the system — the Luma
sync, the repository importer, the admin — goes through `setPrimaryHost()` /
`clearPrimaryHost()` in `src/server/events/hosts.ts`. Nothing else may write
that column. `attributionDrift()` is the same query in production that
`tests/event-hosts.test.ts` runs after every mutation, and a non-empty result
is a bug in that module by definition.

Two database constraints do the rest of the work: the primary key
`(event_id, ambassador_id, role)` makes double-counting one credit
unrepresentable, and a partial unique index allows only one `primary_host` per
event.

### Matching is exact against a configured mapping, never fuzzy

The Claude Community calendar is an ICS feed. Its entire statement about who
runs an event is `ORGANIZER;CN="Some Name"` plus a MAILTO that is the same
generic calendar address on all 317 events. There is no Luma user id and no
profile URL in the feed.

So the only available key is a name — and matching on `ambassadors.name` is
forbidden, because two people share a surname and nobody notices the wrong
attribution. Instead the match is against `ambassadors.luma_display_name`: a
column that is empty by default and holds the organiser string **an admin has
actually seen and assigned**. Exact, on the normalised value, with a unique
index on `lower(btrim(...))` so one organiser string cannot be configured
against two ambassadors and the matcher never has to break a tie.

Preference order, when a source ever offers more: `luma_external_id` (stable
provider id, unique, null today) → `luma_display_name` (configured mapping).
`luma_profile_url` is editorial only — a link on the profile, never a key.

What this costs is coverage. Measured on the live capture: 317 events in the
feed, 13 placed in India across 8 cities, and **zero attributed** until a
mapping is configured. Three of those 13 are hosted by "Aniket Sahu", the
ambassador already on the record — so configuring one string attributes three
real events. That trade is deliberate: an unattributed event is honest and
fixable, a wrongly attributed one moves a public leaderboard quietly.

Attribution runs as its own pass over every promoted record, **not** only over
records the feed changed. It was originally inside the promotion branch, which
meant an admin could configure a mapping, run the sync, and see nothing happen
— the events had not changed, so the code never looked at them. Attribution
depends on our configuration, not on the feed's revisions.

A sync will not overwrite an attribution it did not write. A `curated` row came
from a human authoring the archive; a `manual` row came from a moderator
correcting that event. A feed reasserting its guess hourly would undo the
correction every time and look like a haunting rather than a bug.

### The activity index

Two public numbers, per §19–§22: **events hosted** and a **community activity
score**, with the formula printed on the page rather than explained in a
tooltip. Weights are a frozen table in `src/lib/credits.ts`:

| role | credit |
|---|---|
| primary host | 1.0 |
| organiser | 1.0 |
| co-host | 0.5 |
| partner | 0.25 |
| speaker | 0 |

`speaker` is in the table at zero on purpose: leaving the role out would mean a
speaker credit fell through to a default, and a default is how a weight gets
assigned by accident.

Determinism is a requirement, so: no model, no "importance", no randomness;
`now` is a parameter rather than read from the clock inside a comparison; and
the sort is total — score, then events, then upcoming, then name, then slug,
which is unique. Without a final unique key, ties are left in engine-defined
order and "same state, same ranking" is false on most real inputs.

Not counted, because the sources do not publish them and inventing them would
be worse than omitting them: registrations, attendance, reach, followers,
engagement, growth. A cancelled event counts for nothing. An attribution below
full confidence is **shown and not scored** — visible on the page as awaiting
confirmation, which is what lets the system hold an uncertain claim without
either discarding it or letting it move a ranking.

Windows are all-time (the default), this year and this month, and a windowed
view never replaces the all-time figure — a page showing only the current year
would make a long-term organiser look inactive for eleven months of it.

The score is **derived on every build** and never stored, which is what makes
determinism provable: no cached total can disagree with the rows, because no
total is cached. The admin's "recalculate" is therefore honestly a public
rebuild, and it reuses `triggerDeploy()` rather than reading the deploy hook
itself — one deploy path, enforced by `tests/admin-isolation.test.ts`.

### Labelling

"WITH CLAUDE Community Activity", never "official Claude Ambassador ranking".
The pages say in plain words that the index is calculated by this website from
event records, is not an Anthropic ranking, and implies no endorsement.
`ambassadors.verified_via` is NOT NULL and is **rendered on the profile**: a
title with its source beside it is a claim a reader can check, and a title on
its own is one they have to take on trust. The admin refuses to create a record
without it.

### Routes and reads

`/ambassadors` and `/ambassadors/[slug]` are prerendered from the same
`RecordSet` the events and cities pages read, so no public page calls Luma and
an ambassador page costs no queries at render time. Ambassadors are reachable
from the footer's Discover column, city pages and event pages — deliberately
not the masthead, which stays at five links and a CTA.

Search indexes ambassadors into the **existing** index as `person` records with
one ranking model, and only for ambassadors who have no builder record —
otherwise the same human would appear twice under two URLs.

---

## 7. Moderation and audit

Admin is **not** a publishing gate. Members publish instantly; moderators act
reactively — dismiss, restrict, restore, archive, soft-delete.

Every moderator mutation writes to `audit_log`, which is **append-only**: a
trigger from migration 0001 refuses every `UPDATE`. The ambassador and
attribution vocabulary: `ambassador.created`, `ambassador.updated`,
`ambassador.linked`, `ambassador.disabled`, `event.host.linked`,
`event.host.unlinked`, `leaderboard.recalculated`. `action` is free text
because this log outlives any particular vocabulary — an entry written today
must still read correctly after a status is renamed or retired. A consequence worth
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

`/ambassadors` is the register: add, edit, set the Luma identity, link a member
account by username, publish, disable. Created as a draft — being able to add
an ambassador does not imply that adding one should immediately alter a public
leaderboard. `verified_via` is required, and a database conflict on the
organiser-name index is translated into a sentence explaining that one
organiser string maps to one person.

`/attribution` is the working queue: source health with the freshness each mode
can actually deliver, the organiser names no ambassador claims (commonest
first, so the mapping worth configuring reads at the top), and the ingested
events with no host credit. Scoped to events that reached the site — an earlier
version listed every staged organiser and returned 134 names, almost all of
them people who have never run an event in India.

Both are open to `editor` and `admin`, not `admin` alone: §36 puts ambassador
management among a moderator's ordinary duties. A `reviewer` cannot — creating
a public profile is not reviewing one. Moderators gain no project-edit
permission from any of this.

Corrections never touch `event_source_records`: the staged row keeps saying
exactly what the feed said, forever, and the correction lives in `event_hosts`
beside it marked `manual`, which is what makes it survive the next sync.

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

> **`drizzle-kit generate` is not safe in this repository.** The `meta/`
> snapshots stop at `0009` because every migration since has been hand-written,
> so a generated diff re-emits the tables from `0010`, `0011` and `0012`
> together and fails on any database that already has them. Write the SQL and
> add the journal entry by hand. Migration `0012` is a worked example: four
> nullable columns, two enums, one table, one backfill, nothing dropped.

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
`published`, ambassadors on `published`, cities via `indexableCityPaths()`.

Ambassador pages are indexable public profiles: each carries a canonical URL,
title, description, OG data and `Person` + `ProfilePage` structured data whose
`sameAs` only ever lists links the page actually renders.

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
