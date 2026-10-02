# Rollout and rollback runbook

Nothing in this branch has been deployed or migrated against the shared Neon
database. Every production step below needs an explicit go-ahead from the
project owner.

## What changes in the database

| Migration | Kind | Safe with the previous app version? |
| --- | --- | --- |
| `0014_phase_a_project_authority` | enum `content_authority`; `projects.featured_order`, `.content_authority`, `.published_at`; table `project_credits`; 4 indexes; data backfills (below) | **Yes.** Old code never selects the new columns. |
| `0015_content_operations` | `events.content_authority`; tables `integration_mappings/jobs/runs/state`, `project_claims`, `import_batches/crosswalk/ledger`; enums | **Yes.** Old code ignores them. |
| `0016_project_directory` | enum `project_build_status`; `events.rescheduled_from`, `.short_title`; `media.provenance`, `.source_url`; `projects.problem`, `.solution`, `.built_with`, `.build_status`, `.download_url`, `.artifact_url`, `.alt_video_url`, `.logo_media_id`, `.logo_path`; three guarded data updates (below) | **Yes.** All additive; old code ignores the columns. The data updates change one event's date and title — visible on the old app too, and correct there. |

The new code **requires** all three migrations (it selects the new columns),
so the order is always: migrate, then deploy.

### 0016 data updates, and what they change

All three are targeted (by slug / feed identity, never a text search),
guarded, and a no-op when re-run.

1. **Visible:** Impact Lab 2 (`claude-impact-lab-september`, the curated row —
   `source_id IS NULL`) moves from 13 to **15 September 2026**, 09:00–18:00
   (its own Luma record), title `Claude Code Impact Lab 2`, short title
   `Impact Lab 2`, `rescheduled_from = 2026-09-13`. Same UUID, same slug, so
   no redirect is needed. Applied only while it is still on the 13th.
2. The Claude Conversation's description loses "spends the next day" (only if
   it is exactly the old sentence).
3. The Luma-ingested Bhopal Fable 5.1 Build Day (`evt-4zpHOs9YWXolVLg`) gets
   the short title `Fable 5.1 Build Day` (only if it has none).

Before and after, on the target database:

```sql
select id, slug, title, short_title, date, rescheduled_from, start_time, end_time, source_id is null as curated
from events
where slug in ('claude-impact-lab-september', 'claude-conversation-september', 'bhopal-claude-code-build-day-fable-5-1');
-- Production on 2026-10-02 (read-only check): the Impact Lab is 01d01dde-6451-4ecc-8ffe-f04f14c60118, curated, on 2026-09-13.
-- Expected after: the same id on 2026-09-15 with rescheduled_from 2026-09-13.
select count(*) from projects where built_at_event_id in
  ('01d01dde-6451-4ecc-8ffe-f04f14c60118', '63aa1fc0-02fd-4e62-be82-8d3648efe159');  -- 0 before the import
```

The Luma sync cannot undo the move: a feed record matched to a curated event
links to it and writes nothing to it (`tests/project-directory.test.ts` proves
this with a feed that still says the 13th). Once the event is adopted into
Baserow, the Baserow row carries the held date.

### 0014 data backfills, and what they change

1. `content_authority = 'member'` for every project with an owner — no visible change.
2. `published_at` for published member projects from their first
   `project.published` audit entry (else `updated_at`) — affects "Newest" order only.
3. Legacy `status` set from `publication_status` for member projects — admin lists now agree with the site.
4. **Visible:** curated projects an editor *archived* in the admin
   (`status = 'archived'`) but which stayed public because
   `publication_status` was still `published` are now archived. This applies a
   takedown that was already recorded. Check the list first:

   ```sql
   select slug, title from projects
   where content_authority = 'curated' and status = 'archived' and publication_status = 'published';
   ```

5. Covers: `image_id` linked where a media row exists for the same project and
   URL; such media marked `published` if the project is. An `image_path` URL
   with **no** media row is no longer rendered — list those first:

   ```sql
   select p.slug, p.image_path from projects p
   left join media m on m.project_id = p.id and m.blob_url = p.image_path
   where p.image_path ~ '^https?://' and m.id is null;
   ```

   Not applied automatically (it would publish content): projects an editor
   *published* in the admin whose `publication_status` is still `draft`.
   Review and decide:

   ```sql
   select slug, title from projects
   where content_authority = 'curated' and status = 'published' and publication_status = 'draft';
   ```

## Rollout

1. **Staging database.** Create a Neon branch from production (Neon →
   Branches). Point a Vercel preview's `DATABASE_URL` at it. Never rehearse on
   production.
2. Run the three review queries above on the branch and record the results.
3. `DATABASE_URL=<branch> npm run db:migrate`. Re-run the queries; the
   archived list should now be empty.
4. Deploy this branch as a preview against the staging database. Run the
   checks in "Verification" below.
5. Real Privy check on the preview: sign in with a real account, open
   `/me/profile/edit/`, save, publish, sign out, sign in as a second account.
   Confirm the Privy dashboard allows the preview origin, and whether the app
   uses Privy server cookies (if it does, the preview host will NOT receive the
   cookie — expect the "could not read your session" explanation instead of a
   loop, and test on the production domain).
6. Baserow (optional at this stage): follow `docs/baserow/setup.md` in a
   staging workspace with `BASEROW_SYNC_ENABLED=true` on the preview only.
   Run `npm run baserow:check-schema`, *Reconcile now*, then edit a row and
   watch it arrive.
7. Production: with approval, `npm run db:migrate` against production, then
   promote the deployment. Keep `BASEROW_SYNC_ENABLED=false` in production
   until staging has run for a while.

## The Baserow event archive (database 578390) — production steps

What exists after the import: two **Events** rows that adopt the production
Neon events by **Neon ID** (`01d01dde-…` Impact Lab 2, `63aa1fc0-…` Fable 5.1 —
ids from the read-only check above; re-check them before step 4), and 94
**Projects** rows (77 `published`, 17 `draft` held for review), keyed by
source key. No ProjectCredits rows. Production Neon has none of these
projects yet, so the first production sync CREATES them.

In order, each with the owner's go-ahead:

1. Re-check production read-only: migration count (expect 14 = 0000–0013 until
   step 2), the two event ids and their current dates, and
   `select count(*) from projects where built_at_event_id in (<the two ids>)`
   (expect 0).
2. Apply migrations 0014–0016 to a Neon **branch** of production, then to
   production (`npm run db:migrate`). 0016 moves Impact Lab 2 to 15 September
   with `rescheduled_from = 2026-09-13`.
3. Deploy this branch (it requires the migrations). Keep
   `BASEROW_SYNC_ENABLED=false`.
4. Compare the two Baserow Events rows with the production events
   field by field (title, summary, description, venue, address, times,
   registration URL, cover, featured). Adoption makes the Baserow row the
   source of truth: anything that differs is what the site will show. The rows
   were mirrored from the local copy, which came from `src/data/events.ts` and
   the Luma sample feed.
5. Create a **read-only** database token for the three tables. In Vercel
   Production set `BASEROW_API_URL`, `BASEROW_READ_TOKEN`,
   `BASEROW_WEBHOOK_SECRET` (≥ 32 random characters) and `BASEROW_CONFIG`
   (the one line in `.dev-auth/baserow.config.json` — field ids, not secret).
   Never put the import token in Vercel.
6. Set `BASEROW_SYNC_ENABLED=true`, redeploy, then admin → **Content sync →
   Reconcile now** until the queue is empty. Expect: 2 events adopted, 94
   projects created (77 public, 17 draft), nothing quarantined (the blank
   default rows were deleted on 2026-10-02).
7. Check `/projects/?event=claude-impact-lab-september` (16) and
   `…bhopal-claude-code-build-day-fable-5-1` (61), two project pages, both
   event pages, and that a held draft (e.g. `/projects/bhopal-flow/`) is 404.
8. Webhooks (section 5 of `docs/baserow/setup.md`) on all three tables, then
   *Trigger test webhook* and watch Content sync. Until a webhook is verified
   the daily reconciliation is the only automatic path.

Undo, if needed: `BASEROW_SYNC_ENABLED=false` stops further changes; the
created projects can be archived from Baserow (set `archived`) — never by
restoring a database backup.

## Verification on a preview

- `/api/health/` with `Authorization: Bearer $CRON_SECRET` → `ok: true`,
  `privy: true`, `privyVerification` as expected, `privyAppIdsMatch: true`,
  `baserow: "disabled"` (or `"enabled"`). Without the header it answers only
  `{ "ok": true }`.
- `curl -I` a project page: `s-maxage=30, stale-while-revalidate=30`; a
  missing slug answers **404**.
- Hide a project as a moderator, then request it anonymously every 10 s and
  record when it starts answering 404 — this is the real CDN bound (expected
  ≤ ~60 s). Record the number in `docs/caching.md`.
- The account journeys (`scripts/dev/journey.mjs` covers them locally).

## Rollback

- **App:** promote the previous deployment in Vercel. Both migrations are
  additive and the previous code ignores the new columns and tables, so no
  database change is needed to roll back the app.
- **What rolling back the app reopens:** the old code accepts arbitrary
  `imagePath`, lets contributors archive projects, and caches moderator views
  publicly. Prefer fixing forward; roll back only for an outage.
- **Baserow:** set `BASEROW_SYNC_ENABLED=false`. The last valid projection
  stays; nothing is deleted. To detach an adopted event, set its
  `content_authority` back to `curated` (feed sync then resumes updating it).
- **An import batch:** `npm run import -- rollback --batch <id> --yes`
  (reverts only rows nobody has edited or claimed since).
- **Never** restore a whole-database backup to undo a content change; it
  would erase newer member edits.

## Outstanding — needs the owner

| Item | Needed from |
| --- | --- |
| Apply migrations 0014/0015/0016 to staging, then production | Approval + Neon access |
| ~~Create the import fields; run the September import into Baserow; delete the blank default rows~~ — done 2026-10-02, verified by read-back (`docs/imports/2026-10-baserow-migration.md`) | — |
| Rotate the import token (it was shared in a chat) and create a separate read-only database token for the sync | Baserow account |
| Decide the 18 held projects (Review notes on each draft; Fable row 8 is held outside Baserow as a likely duplicate of /projects/headline-threads/) | Organisers |
| Favicon enrichment for the directory (`npm run import -- enrich-logos`) — deferred until there is a media store | `BLOB_READ_WRITE_TOKEN` |
| Permission to publish individual builder names (none are published today) | Organisers / teams |
| Privy dashboard: allowed origins for preview/production; whether server cookies are on | Privy dashboard access |
| `BLOB_READ_WRITE_TOKEN` in production (uploads answer 503 without it) | Vercel env access |
| Baserow plan choice, a read-only database token for the sync, webhook secret | Baserow account |
| Consent basis for public names in the two event spreadsheets (received; names withheld until then) | Organisers |
| Decision on admin-published-but-draft curated projects (query above) | Editor |
