# Implementation progress

Working log for the WITH CLAUDE reliability / Baserow plan. Each phase records
what changed, how it was verified, and what is still blocked. Historical
comments and old test counts elsewhere in the repo are evidence, not proof —
everything below was re-run on this branch.

## Baseline (2026-10-01, commit `83a8f41`, branch `main`, clean tree)

- Node 24.14.0, npm workspaces (`admin`), lockfile `package-lock.json`.
- `npx vitest run`: **38 files, 931 tests, all passing** (40 s).
- `tests/equivalence-neon.test.ts` connects to the Neon database named in the
  local `.env` and **reads** it (SELECT only). No test writes to it. Every new
  test in this work uses PGlite (`db/testing.ts`) or an isolated local
  PostgreSQL cluster; nothing in this work writes to the Neon project in
  `.env`, which is the shared preview/production database.
- `npm run build` = `npm run prebuild && astro check && astro build`. npm also
  runs the `prebuild` lifecycle script automatically before `build`, so the
  snapshot step runs **twice** per `npm run build`. With `DATA_SOURCE=ts` it is a
  no-op; with `DATA_SOURCE=db` it reads the database twice. No migration runs
  during a build.

## Execution checklist

### Phase A — core correctness
- [ ] A1 Project lifecycle module: one public predicate, permission matrix
      (owner / collaborator / contributor), central transitions, legacy
      `status` ↔ `publicationStatus` compatibility mapping, transactional audit
      with before/after.
- [ ] A2 Project API routes (`PUT`, publish, archive, restore) enforce the matrix
      server-side; arbitrary `imagePath` writes replaced by an authorised
      `coverMediaId`; cover media published with the project.
- [ ] A3 Moderation restore preserves publication state (projects and builders);
      moderation routes get the same-origin guard; admin publish/archive of a
      project moves `publicationStatus` too.
- [ ] A4 Project detail: Built-at via event UUID, `clean`-only public
      eligibility, bounded queries, real 404 status, private/no-store for
      moderator or non-public renders, bounded public TTL.
- [ ] A5 Builder detail: legacy image fallback, real 404, cache isolation.
- [ ] A6 Auth: editors mounted beneath the single `PrivyProvider` (portal +
      lazy load + typed JSON props); explicit auth states; no redirect loop on
      `no-member`/stale-cookie; identity-scoped reset on logout/account switch;
      health indicator matches real Privy configuration.
- [ ] A7 Profile: clearable website/role/text fields, live city options,
      unsaved-change warning, effective-visibility display.
- [ ] A8 Sitemap/city eligibility matches live pages (events + ambassadors).

### Phase B — design and public/account UI
- [ ] B1 Shared tokens/components (cards, cover placeholder, buttons, inputs,
      pagination, empty states).
- [ ] B2 Homepage: SSR, 5 sections, explicit live data, live JSON-LD.
- [ ] B3 Projects index: server-side search/filters/sort/pagination, counts,
      consistent covers and deterministic placeholders.
- [ ] B4 Project detail redesign; events index/detail archive behaviour; account
      dashboard.
- [ ] B5 Visual review at 375 / 768 / 1440 with screenshots.

### Phase C — Baserow and import infrastructure (feature-flagged, default off)
- [ ] C1 Schema spec, authority map, field-ID config template, setup guide.
- [ ] C2 Migration: provider mappings, integration jobs, sync runs,
      quarantine, import batches/ledger, project content authority.
- [ ] C3 Typed Baserow client (pagination, timeouts, backoff, concurrency).
- [ ] C4 DTO validation + mapping adapter + transactional projection.
- [ ] C5 Webhook endpoint (secret header, size bound, durable jobs, bounded
      processing), reconciliation runner, admin status/retry.
- [ ] C6 CSV/XLSX importer CLI: inspect, map, dry-run report, apply, rollback.

### Phase D — onboarding and rollout
- [ ] D1 Requires real spreadsheets, Baserow credentials and a staging database.

## Phase log

### Phase A + B — core correctness and the public/account UI (branch `feat/reliability-and-content-ops`)

Code-confirmed defects fixed (each has a test or a journey check):

| Defect | Where it was | Fix |
| --- | --- | --- |
| Contributor (credit-only) could archive/restore the owner's project | `api/projects/[id]/{archive,restore}` | Permission matrix in `src/server/projects/lifecycle.ts`; owner-only lifecycle |
| Archive/restore moved `publicationStatus` but not legacy `status`, no audit | same | `transitionProject()` writes both + audit before/after in one transaction |
| Admin publish/archive of a project moved only `status`, so an admin takedown never left the site | `admin/src/server/publishing.ts` | `projectPublicationFor()`; migration 0014 applies already-recorded takedowns |
| Moderation restore published moderated drafts; remove overwrote publication with `deleted` | `src/server/moderation.ts` | Moderation only writes `moderationState`; restore preserves publication |
| Moderation routes had no same-origin check | `api/moderation/*` | `guardMutation()` |
| Any string accepted as a project cover (`imagePath`) | `api/projects/[id]` | `coverMediaId` validated against media rows for that project; `/api/media/confirm` verifies with `head()` |
| Blob completion callback always refused (no Origin/cookie) | `api/media/upload` | Signed callback bypasses browser checks; `handleUpload` verifies HMAC |
| Detail page admitted `reported`; Built-at never resolved (UUID looked up by slug) | `projects/[slug]` | `publicProjectWhere()` everywhere; event joined by UUID |
| Moderator render carried the public CDN header; 24 h stale window everywhere | SSR pages | `src/server/http/cache.ts`: public 30 s + 30 s stale; viewer-specific renders `private, no-store`; moderator view only via `?moderate=1` or non-public |
| `Astro.redirect('/404')` (302 → 200) for missing content | detail pages | Real 404 with shared `NotFound` |
| Stored XSS via JSON-LD (`JSON.stringify` inside `<script>`) | `Base.astro` | `safeJsonLd()` |
| Restricted builders with `status=published` stayed in `publicBuilders`; search listed no builders at all | `source-db.ts`, `directory.ts` | Reader withholds held builders; search filter fixed |
| Legacy builder portraits never rendered (`asset(undefined)`) | `builders/[slug]` | `builderImage()` fallback |
| Website / role could never be cleared | profile schema + editor | `""`/`null` mean clear |
| Editors were separate React roots with no `PrivyProvider` | `/me/*` | Mounted beneath the one provider via `AccountIsland` portals |
| Sign-in redirect loop when the server cannot see the session; sessionStorage cache trusted over the server | `PrivyRoot.tsx` | Explicit state machine, return guard, identity-scoped storage |
| Provider init failure left editors on "Loading…" forever | `PrivyRoot.tsx` | Error boundary + degraded cookie-only mode |
| Health reported Privy unconfigured on JWKS deployments | `api/health.ts` | Mirrors `privyConfig()` |
| Sitemap missed cities whose only signal is an event/ambassador/story | `sitemap.xml.ts` | Same five signals as the city page |
| Related-projects query: `ORDER BY false` (500) and NULLS-first ordering | `public/projects.ts` | Found by the HTTP journey; fixed + tested |
| Published project could be edited into an incomplete state | `api/projects/[id]` | Publish blockers re-checked on edits to live projects |
| Masthead and WITH index overflowed at 375 px | `Masthead.astro`, `WithIndex.astro` | Narrow-phone layout |
| `db:import` could not reach a local PostgreSQL (README said it could) | `db/import/run.ts` | Driver chosen by URL |

UI: homepage rebuilt as SSR with five sections; projects archive with
server-side search/filters/sort/pagination; project detail; shared
`ProjectCover`/`ProjectCard`/`EventCard`; account dashboard, project list and
editors on shared form styles (`src/styles/forms.css`). Manifesto and the
WITH index moved to `/about`, the national signal to `/community`.

Migration `0014_phase_a_project_authority`: additive (enum, three columns,
`project_credits`, four indexes) plus guarded data backfills. Apply it
**before** deploying this code — the new code selects the new columns.

Verification (2026-10-02, local):

- `npx vitest run`: 39 files; 923 passed, 35 skipped; 1 file fails —
  `tests/equivalence-neon.test.ts`, because it reads the shared Neon
  database, which does not have migration 0014. Expected until the migration
  is applied there; no code defect.
- `npx astro check`: 0 errors.
- Isolated PostgreSQL 18 cluster (`127.0.0.1:55432`, own data dir), all
  migrations + curated import, `astro dev`:
  `scripts/dev/journey.mjs` — 47/47 HTTP checks pass;
  `scripts/dev/browser-journey.mjs` — 16/16 browser checks pass;
  `scripts/dev/visual-review.mjs` — 375/768/1440 screenshots, no overflow,
  one `<main>`, the only console error is Privy rejecting the local fake app
  id (handled by the degraded mode).
- Auth in these journeys uses locally minted ES256 tokens verified by the
  unchanged production code path with a local `PRIVY_VERIFICATION_KEY`. Real
  Privy OAuth, production cookies and dashboard origins are NOT verified.
- Local toolchain note: Vite's nested esbuild 0.25.12 segfaults on this
  Windows build (`const a = 8000` crashes it). For local runs only, Vite was
  pointed at the root esbuild 0.27.7 inside `node_modules`; nothing committed
  depends on that, and Linux/Vercel builds are unaffected.

(Later phases are appended below.)
