# Content authority — who may write what

Exactly one writer per field and content domain. When two systems can write
the same row, one of them will eventually overwrite the other.

| Domain | Editing authority | How it reaches the site | Enforced by |
| --- | --- | --- | --- |
| Curated event details and publication intent | Baserow, **after explicit adoption** (`neonId` on the Baserow row) | Validated projection into the existing `events` row; UUID and slug kept | `events.content_authority = 'baserow'`; projection writes only such rows |
| Imported, unclaimed project descriptions, links, team credits | Baserow | Validated projection into `projects` / `project_credits` | `projects.content_authority = 'baserow'` |
| Member-created or successfully claimed projects | The website (`/me/projects/…`) | Direct, through `/api/projects` | `content_authority = 'member'`; projection marks the mapping `released` and skips |
| Account, profile, identity, roles, ownership | Neon (website + admin) | — | Never read from Baserow rows or request bodies; DTOs cannot carry these fields |
| Moderation and report restrictions | Neon (moderators) | Immediate | Projection never writes `moderation_state`; public predicate requires `clean` |
| Luma / ICS ingested events | The existing feed, until an organiser adopts the event | Existing `syncSource()` | `promote()` and `withdrawEvent()` skip `content_authority = 'baserow'` rows; the feed's view stays in `event_source_records` for review |
| Homepage featured selection | Baserow `featured` / `featured order` (projects) | Projection; rendered only if the record is public | `publicProjectWhere()` at read time |
| Curated archive (`src/data/*.ts`, admin promotions) | Editors via the admin state machine | Admin publish/archive (now also moves `publication_status`) | `content_authority = 'curated'` (the fail-closed default) |
| An event's held date, announced date (`rescheduled_from`) and badge label (`short_title`) | Whoever owns the event row above (curated → `src/data/events.ts` + migration; adopted → Baserow) | The same row everywhere — every project badge, filter, detail page and event page joins on `built_at_event_id` | Feed ingestion never writes a curated or adopted row, and never writes `short_title` at all |
| Favicon logos (`projects.logo_media_id`, `media.provenance = 'favicon'`) | The import-time enrichment job only | Stored media; pages never fetch a participant site | The job only fills an empty logo; an owner/organiser logo always outranks it |
| Individual builder names from event forms | Nobody, until the team gives permission | — | The source adapter never copies a member-name column; team labels that are a person's name are withheld |

## Rules

- **A city is never created from Baserow.** A City field is either a link to
  the Cities table or — in a workspace without one — text holding an existing
  Neon city slug. Either way an unknown city is quarantined.
- **Identity is the Baserow row id.** `(provider, table_id, row_id)` maps to a
  Neon UUID in `integration_mappings`. Titles, slugs and row positions are
  never used to match.
- **Adoption is explicit and one-to-one.** A Baserow row adopts an existing
  Neon event or project only by naming its UUID in `neonId`; a second row
  naming the same UUID is quarantined.
- **Slugs are permanent once public.** The projection changes a slug only for
  a record that has never been published, and only to a free value.
- **Credits are not accounts.** A `project_credits` row is a public display
  name. It never creates a member and never links to a profile unless a
  verified association (an approved claim) set `builder_id`.
- **Claims transfer authority atomically.** An approved project claim sets the
  owner, moves `content_authority` to `member`, and releases the Baserow
  mapping in one transaction. Provenance (mapping, credits, audit) is kept.
- **Deletion upstream is archival.** A deleted Baserow row archives its
  projection and tombstones the mapping. Member-owned records, moderation
  history and other entities are never touched.

## Where each rule lives in code

- `src/server/projects/lifecycle.ts` — permission matrix, public predicate,
  member transitions, `memberCan()` refusing non-`member` content
- `src/server/integrations/baserow/projection.ts` — the only Baserow writer
- `src/server/projects/claims.ts` — claim request and approval
- `src/server/events/sync.ts` — feed ingestion skips adopted events
