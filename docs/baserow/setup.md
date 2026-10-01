# Baserow setup — content operations for WITH CLAUDE

Baserow is where organisers edit curated events and imported projects. The
website never reads Baserow on a visitor request: a server-side sync validates
each row and projects it into Neon, and pages read Neon. If Baserow is down,
or the sync is switched off, the site keeps serving the last valid projection.

**Status of this integration:** implemented and tested against synthetic data
and a fake Baserow API. It has **not** been run against a real Baserow
workspace yet — that needs the credentials and staging checks in
[the rollout runbook](../runbook-rollout.md). The feature flag is **off** by
default.

## 1. Workspace and plan

Use Baserow Cloud. Before choosing a plan, count rows across all four tables
(cities + events + projects + credits). At the time this was written Baserow
documented a 3,000-row workspace limit on Free and 50,000 on Premium, and a
limit of 10 concurrent API requests; the client here never uses more than 4
(3 for the importer). **Confirm current limits and whether the permission
features below exist on your plan at <https://baserow.io/pricing> before
buying anything.** Nothing in this project purchases or upgrades a plan.

## 2. Tables

Create one database with four tables. Field **names** are for people; the
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
| Date | Date (no time) | yes | Local date in the event's time zone. |
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
| How Claude was used | Long text | no | Leave empty if not documented; the site says "Not documented". Never invent it. |
| Event | Link to Events | needed to publish | |
| City | Link to Cities | no | Defaults to the event's city. |
| Team name | Single line text | no | Shown as a public team credit. |
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
