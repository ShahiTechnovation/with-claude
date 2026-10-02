# Baserow setup — content operations for WITH CLAUDE

Baserow is where organisers edit curated events and imported projects. The
website never reads Baserow on a visitor request: a server-side sync validates
each row and projects it into Neon, and pages read Neon. If Baserow is down,
or the sync is switched off, the site keeps serving the last valid projection.

**Status of this integration:** the real workspace (database 578390) has its
fields (created in the Baserow UI on 2026-10-02 — a database token can read
and write rows, never create fields) and holds the September event archive:
2 Events rows and 94 Projects rows, verified by read-back
([reconciliation](../imports/2026-10-baserow-migration.md)). The sync has been
validated against an isolated local database only. The feature flag is
**off** by default, and production sync has not been enabled.

## This workspace (database 578390)

Three tables, no Cities table. Each **City** field is a **text** field holding
the Neon city slug (`bhopal`); the sync resolves it to the existing Neon city
and quarantines an unknown slug — it never creates a city.

| Table | Id | Existing fields (leave them) |
| --- | --- | --- |
| Projects | 1236064 | **Name** (primary) — used as the project title |
| Events | 1236080 | **Name** (primary) — the event title; **Notes**, **Active** — not used by the sync |
| ProjectCredits | 1236082 | **Name** (primary) — the credit's display name; **Notes**, **Active** — not used |

Baserow created Events and ProjectCredits with two **blank default rows**
each (ids 1 and 2). They were deleted on 2026-10-02 by
`npm run import -- archive-delete-blank-rows`, which removes a row only if it
is blank in every field and no link points at it (restorable from Baserow's
trash).

**Accepted differences in the real workspace** (all enforced in code, so the
field type does not have to):

- The six project URL fields, *Registration URL* and *Public profile URL*
  are plain **text**. Every value is validated by the sync (`dto.ts`):
  http(s) only, a public host (no localhost or private address), no embedded
  credentials, no credential-bearing or `_vercel_share` query parameter. A
  bad value quarantines the row; it is never published.
- *Event* (Projects) and *Project* (ProjectCredits) **allow multiple
  relationships**. The sync quarantines a project linked to more than one
  event and a credit linked to more than one project; any number of
  projects may share one event. The importer always writes exactly one.
- Baserow created the reciprocal link fields *Projects* (in Events) and
  *ProjectCredits* (in Projects). They are kept; nothing reads them.

Create these fields (Table → **+** at the end of the header row). Names are
matched case-insensitively, once, by `npm run baserow:discover`; afterwards
the sync uses field ids, so renaming later is safe. A name may drop its
bracketed part (`Short title` for `Short title (badges)`). Long text fields:
leave **rich text formatting off**. Date fields: **no time**. Number fields:
**0 decimal places**. Select options are lower-case exactly as written.
Links are one-way and single: the sync reads only the link it owns, and a
reciprocal field in the other table is not needed (if one exists, keep just
that one — it is harmless). `baserow:discover` refuses duplicate field names,
rich text, a date with time and a link that allows several rows.

**Events** (22 fields; *Luma event id* optional)

| Field | Type | Options / notes |
| --- | --- | --- |
| Key | Single line text | |
| Neon ID | Single line text | |
| Slug | Single line text | |
| Summary | Long text | |
| Description | Long text | |
| City | Single line text | `bhopal` |
| Venue | Single line text | |
| Public address | Long text | |
| Address for registrants only | Boolean | |
| Date | Date | no time |
| Rescheduled from | Date | no time |
| Short title (badges) | Single line text | |
| Start time | Single line text | `HH:MM`, 24-hour |
| End time | Single line text | |
| Timezone | Single line text | |
| Format | Single select | `conversation`, `workshop`, `impact-lab`, `campus`, `hackathon`, `demo`, `meetup`, `other` |
| Registration URL | URL | |
| Cover | Single line text | |
| Lifecycle | Single select | `scheduled`, `cancelled`, `sold-out`, `registration-closed` |
| Editorial status | Single select | `draft`, `ready`, `published`, `archived` |
| Featured | Boolean | |
| Luma event id | Single line text | optional |

**Projects** (22 fields, then optional ones)

| Field | Type | Options / notes |
| --- | --- | --- |
| Key | Single line text | written by the importer; never edit |
| Slug | Single line text | |
| Summary | Long text | |
| Category | Single select | `product`, `agent`, `developer-tool`, `research`, `creative`, `campus`, `experiment`, `startup` |
| Event | Link to table → **Events** | one-way: untick "Create related field in linked table" and "Allow multiple relationships" |
| Team name | Single line text | |
| The problem | Long text | |
| The solution | Long text | |
| Built with (as stated) | Long text | |
| How Claude was used | Long text | |
| Build status (self-reported) | Single select | `functional`, `partial`, `prototype` |
| Live URL | URL | |
| Repo URL | URL | |
| Video URL | URL | |
| Second demo video URL | URL | |
| Download URL | URL | |
| Other artifact URL | URL | |
| Editorial status | Single select | `draft`, `ready`, `published`, `archived` |
| Source batch | Single line text | |
| Source key | Single line text | |
| Source rows | Single line text | original worksheet rows |
| Review notes | Long text | why a record is held; never projected to the site |

Optional on Projects (create them when you want to use them, then re-run
`npm run baserow:discover`): Featured (Boolean), Featured order (Number),
Description (Long text), Cover (text), Logo (text), Tags / tech (text),
Neon ID (text).

**ProjectCredits** (4 fields)

| Field | Type | Options / notes |
| --- | --- | --- |
| Project | Link to table → **Projects** | one-way: untick "Create related field in linked table" and "Allow multiple relationships" |
| Role | Single line text | |
| Public profile URL | URL | |
| Display order | Number | 0 decimal places |

Then:

```bash
. .dev-auth/baserow.env.sh                 # token, git-ignored — never commit it
npm run baserow:discover                   # maps names → ids, writes .dev-auth/baserow.config.json
export BASEROW_CONFIG="$(cat .dev-auth/baserow.config.json)"
npm run baserow:check-schema               # "ok" for events, projects, credits
```

The token supplied for the import can create and update rows in all three
tables (checked without writing: a deliberately invalid value answers 400,
not 401). For the website's sync, create a **separate read-only** database
token and use only that one in Vercel (`BASEROW_READ_TOKEN`).

## 1. Workspace and plan

Use Baserow Cloud. Before choosing a plan, count rows across all four tables
(cities + events + projects + credits). At the time this was written Baserow
documented a 3,000-row workspace limit on Free and 50,000 on Premium, and a
limit of 10 concurrent API requests; the client here never uses more than 4
(3 for the importer). **Confirm current limits and whether the permission
features below exist on your plan at <https://baserow.io/pricing> before
buying anything.** Nothing in this project purchases or upgrades a plan.

## 2. Tables

Create one database with four tables — or three, without Cities (see
[This workspace](#this-workspace-database-578390)). Field **names** are for people; the
sync addresses fields by **id**, so renaming a column later is safe as long as
its type does not change. Types must match — `npm run baserow:check-schema`
verifies them.

### Cities (reference, read-only by convention)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| Neon slug | Single line text | yes | Must equal an existing Neon city slug. Unknown slugs are quarantined, never created. |
| Name | Single line text | no | For people reading the table. |

Seed it with one row per city from Neon (`select slug, name from cities where status = 'published'`).

### Events

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| Key | Single line text | yes | Stable external key, e.g. `evt-bhopal-impact-lab-2026-08`. Never reuse. |
| Neon ID | Single line text | no | Set ONLY to adopt an existing Neon event (its UUID). Adoption moves its editing to Baserow. |
| Title | Single line text | yes | |
| Slug | Single line text | no | Used only until first publication; permanent after. |
| Summary | Long text | yes | |
| Description | Long text | no | Plain text; rendered escaped. |
| City | Link to Cities | yes | |
| Venue | Single line text | yes | |
| Public address | Long text | no | |
| Address for registrants only | Boolean | no | |
| Date | Date (no time) | yes | Local date in the event's time zone — the day it was actually **held**. |
| Rescheduled from | Date (no time) | no | Only when the event moved: the originally announced date. Shown as "rescheduled from …" on the event page; badges and sorting use Date. |
| Short title (badges) | Single line text | no | The label on project badges, e.g. `Impact Lab 2`, `Fable 5.1 Build Day`. Falls back to the title without a "City \|" prefix. |
| Start time / End time | Single line text | start yes | 24-hour `HH:MM`, local wall-clock time. Never converted to UTC. |
| Timezone | Single line text | no | IANA zone; default `Asia/Kolkata`. |
| Format | Single select | yes | `conversation, workshop, impact-lab, campus, hackathon, demo, meetup, other` |
| Registration URL | URL | no | |
| Cover | Single line text | no | A repository asset key (e.g. `covers/cover-vol08.jpg`). Not a URL. |
| Lifecycle | Single select | no | `scheduled, cancelled, sold-out, registration-closed` — separate from editorial status. |
| Editorial status | Single select | yes | `draft, ready, published, archived` |
| Featured / Featured order | Boolean / Number | no | |
| Organisers (public) | Single line text | no | Public labels only. |
| Source URL / Luma event id / Recap URL | URL / text / URL | no | Provenance and recap. |

### Projects

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| Key | Single line text | yes | The importer writes its candidate key here. Never edit it. |
| Neon ID | Single line text | no | Adopt an existing curated project only. |
| Title, Slug, Summary, Description | text / text / long text / long text | title, summary | |
| Category | Single select | yes | `product, agent, developer-tool, research, creative, campus, experiment, startup` |
| Tags / tech | Multiple select (or text) | no | Up to 12, ≤32 chars each. |
| Live URL, Repo URL, Video URL | URL | no | http(s) only. |
| Cover | Single line text | no | Asset key only. Remote screenshots are a review item; the sync never fetches participant URLs. |
| How Claude was used | Long text | no | Leave empty if not documented; the site says "Not documented in the submission". Never invent it. |
| The problem / The solution | Long text | no | The team's own answers, verbatim (line breaks kept, up to 12,000 characters each). The card uses Summary. |
| Built with (as stated) | Long text | no | The stack exactly as the team wrote it. Never inferred from a repository name. |
| Build status (self-reported) | Single select | no | `functional, partial, prototype`. Leave empty when the team did not say — empty is never shown as "functional". |
| Download URL / Other artifact URL / Second demo video URL | URL | no | One kind per field: a release download (APK), an artifact that is not a demo (slides, a Drive folder, a Hugging Face Space), a second recording. |
| Logo | Single line text | no | A repository asset key for an organiser-supplied logo. The favicon job fills a separate media logo; neither is ever a remote URL typed here. |
| Event | Link to Events | needed to publish | |
| City | Link to Cities | no | Defaults to the event's city. |
| Team name | Single line text | no | Shown as a public team label. Leave empty when the label is a person's name and their permission is not on record. |
| Editorial status | Single select | yes | `draft, ready, published, archived` |
| Featured / Featured order | Boolean / Number | no | Homepage ordering. |
| Source batch / Source key | text | no | Written by the importer. |

### Project credits

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| Project | Link to Projects | yes | |
| Display name | Single line text | yes | Public credit. Creates no account. |
| Role | Single line text | no | |
| Public profile URL | URL | no | Only a link the person chose to make public. |
| Display order | Number | no | |

### Suggested views

- Events: *Needs information* (filter: summary or venue empty), *Ready for
  review* (editorial status = ready), *Published*, *Archived*.
- Projects: *Projects by event* (group by Event), *Missing covers* (Cover
  empty), *Needs information* (summary empty, or no URL), *Ready for review*,
  *Published*.

Sync failures are shown in the admin under **Content sync**, not written back
into Baserow.

## 3. Tokens — least privilege

Create two **database tokens** (Settings → Database tokens), never an
account-wide token:

| Token | Permissions | Used by | Env var |
| --- | --- | --- | --- |
| Website read | Read on Cities, Events, Projects, Credits | the sync (webhook, cron, admin) | `BASEROW_READ_TOKEN` |
| Importer write | Create/update/delete on Projects and Credits only | `npm run import` on an organiser's machine | `BASEROW_IMPORT_TOKEN` (local only) |

Database tokens grant row CRUD; they cannot create tables or fields. Create
the schema in the Baserow UI by hand (section 2). The importer token must
never be set in a Vercel environment.

## 4. Configuration

Copy `config/baserow.example.json`, replace the ids with your table and field
ids (Table → ··· → *API documentation* lists them), and set the JSON on one
line as `BASEROW_CONFIG`. Then:

```bash
npm run baserow:check-schema   # must print "ok" for all four tables
```

Server-only environment variables (never `PUBLIC_`):

```
BASEROW_SYNC_ENABLED=false        # "true" to turn the projection on
BASEROW_API_URL=https://api.baserow.io
BASEROW_READ_TOKEN=…
BASEROW_WEBHOOK_SECRET=…          # ≥ 32 random characters
BASEROW_CONFIG={"tables":{…}}
```

## 5. Webhook

In each of the four tables: *Webhooks → Create webhook*

- URL: `https://www.withclaude.in/api/integrations/baserow/webhook/`
- Method: POST; events: rows created, rows updated, rows deleted
- Add a custom header **`X-WithClaude-Webhook-Secret`** with the value of
  `BASEROW_WEBHOOK_SECRET`.

Baserow authenticates its calls only with headers you configure; it does not
sign payloads, so the secret header over HTTPS is the authentication. The
handler ignores row contents in the payload and re-reads each row from the
API, so a stale or forged payload can at most cause a re-read.

**Verify before relying on it:** use Baserow's *Trigger test webhook* and
check the admin's Content sync page. The handler expects `table_id`,
`event_type` (`rows.created|rows.updated|rows.deleted`) and `items[].id`
and/or `row_ids`; if the live payload differs, `parseWebhook()` answers 422
and the call is visible in Baserow's webhook log.

## 6. Freshness — what is and is not promised

| Situation | When the site reflects an edit |
| --- | --- |
| Webhook delivered, queue healthy | The webhook request itself processes the job (≤ 8 s budget), then the CDN TTL (≤ 60 s). Target: **under two minutes.** |
| Webhook delivered but the slice ran out of time | The next webhook, the daily reconciliation, or *Process queue now*. |
| Webhook dropped (Baserow's pending-call limit, retries exhausted) | The **daily** reconciliation (`/api/cron/baserow-reconcile`, 21:15 UTC), or *Reconcile now* in the admin. The current Vercel plan's crons are daily, so a dropped webhook can take **up to a day** to repair on its own. |
| Moderator restricts a project | Immediately in Neon; off public pages within the CDN bound (≤ 60 s). Baserow cannot override it. |

Functions are capped at 15 s (`astro.config.mjs`), so every run is bounded:
8 s for a webhook, 12 s for cron/admin. Jobs are leased for 60 s and retried
with exponential backoff (30 s, 1 min, 2 min, … up to 30 min, 6 attempts);
configuration errors (401/403/400, schema mismatch) are not retried — they
show as *failed* until fixed and retried from the admin.

## 7. Turning it on, and off

On: complete sections 2–5 in **staging** first, run `baserow:check-schema`,
set `BASEROW_SYNC_ENABLED=true`, press *Reconcile now* in the admin, and
check the counts. Off: set `BASEROW_SYNC_ENABLED=false`. Webhooks are then
acknowledged and ignored; Neon keeps the last valid projection; nothing is
deleted. See the [rollout runbook](../runbook-rollout.md).
