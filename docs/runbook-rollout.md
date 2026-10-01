# Rollout and rollback runbook

Nothing in this branch has been deployed or migrated against the shared Neon
database. Every production step below needs an explicit go-ahead from the
project owner.

## What changes in the database

| Migration | Kind | Safe with the previous app version? |
| --- | --- | --- |
| `0014_phase_a_project_authority` | enum `content_authority`; `projects.featured_order`, `.content_authority`, `.published_at`; table `project_credits`; 4 indexes; data backfills (below) | **Yes.** Old code never selects the new columns. |
| `0015_content_operations` | `events.content_authority`; tables `integration_mappings/jobs/runs/state`, `project_claims`, `import_batches/crosswalk/ledger`; enums | **Yes.** Old code ignores them. |

The new code **requires** both migrations (it selects the new columns), so
the order is always: migrate, then deploy.

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

## Verification on a preview

- `/api/health/` → `ok: true`, `privy: true`, `privyVerification` as expected,
  `privyAppIdsMatch: true`, `baserow: "disabled"` (or `"enabled"`).
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
| Apply migrations 0014/0015 to staging, then production | Approval + Neon access |
| Privy dashboard: allowed origins for preview/production; whether server cookies are on | Privy dashboard access |
| `BLOB_READ_WRITE_TOKEN` in production (uploads answer 503 without it) | Vercel env access |
| Baserow workspace, plan choice, two database tokens, webhook secret, table/field ids | Baserow account |
| The two previous-event spreadsheets and their consent basis for public names | Organisers |
| Decision on admin-published-but-draft curated projects (query above) | Editor |
