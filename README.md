# WITH CLAUDE

The community directory and event record for people building with Claude in India.

- Site: <https://www.withclaude.in>
- Project directory: <https://projects.withclaude.in>
- Admin, staff only: <https://admin.withclaude.in>

WITH CLAUDE is an independent, volunteer-run community project. It isn't an Anthropic property,
programme or endorsement. See [Relationship to Anthropic](#relationship-to-anthropic).

## Contents

- [Overview](#overview)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Scripts](#scripts)
- [Testing](#testing)
- [Continuous integration](#continuous-integration)
- [Deployment](#deployment)
- [Architecture](#architecture)
- [Governance and data integrity](#governance-and-data-integrity)
- [Data operations](#data-operations)
- [Design, accessibility and search](#design-accessibility-and-search)
- [Contributing](#contributing)
- [Security](#security)
- [Relationship to Anthropic](#relationship-to-anthropic)
- [Credits](#credits)

## Overview

The site answers practical questions about the Claude community in India: what's happening and
where, who is building, what they made, and how to take part.

- **Events** sync nightly from the community's Luma calendar. Each one gets a page with its venue,
  hosts, photographs and the projects built there.
- **Cities** are plotted on an atlas by their real coordinates. A city's community state is derived
  from verified records and can't be set by hand.
- **Builders and Ambassadors** have public profiles. Members can claim and edit their own.
- **The project directory** (`projects.withclaude.in`) lists projects with filters, member
  submissions, claims and moderation.
- **Practice archives** hold stories, use cases and guides, each held to a published standard.
- **Search** at `/discover` covers the whole record.
- **Member accounts** live under `/me/`, with sign-in through Privy.
- **The admin app** is where staff review submissions, moderate content, manage attribution and
  run integrations.

Three rules apply across the codebase:

1. **Nothing is invented.** Events, dates, venues, photographs and credits come from the real
   community record. An empty archive shows a designed empty state, never filler.
2. **Derived state has one owner.** Event lifecycle lives in `src/lib/status.ts` and city state in
   `src/lib/city.ts`. Pages read the selectors in `src/data/index.ts` and never decide these
   things themselves.
3. **Public pages work without JavaScript.** Motion, the atlas readout, filters and forms are
   enhancements. With scripts blocked, every public page still renders and navigates.

## Tech stack

| Area               | Choice                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| Framework          | Astro 5 and TypeScript. `output: 'static'`, with on-demand routes        |
| Interactive UI     | React 19 islands, plus small vanilla TypeScript islands                  |
| Database           | Neon PostgreSQL with Drizzle ORM; migrations through `drizzle-kit`       |
| Member sign-in     | Privy                                                                    |
| Staff sign-in      | Better Auth magic links, in the admin app only                           |
| Media              | Vercel Blob for member uploads; `astro:assets` and sharp for repo images |
| Email              | Resend                                                                   |
| Validation         | Zod                                                                      |
| Hosting            | Vercel, functions in `sin1`, Vercel Cron and Vercel Analytics            |
| Event source       | The Luma public iCal feed                                                |
| Content operations | Baserow, optional and off by default                                     |
| Tests              | Vitest. Database tests run on PGlite, PostgreSQL compiled to WebAssembly |
| Tooling            | Prettier, and Playwright for screenshots and smoke checks                |

## Repository layout

```
src/                 the public site
  pages/             routes; HTTP endpoints under pages/api/
  components/        UI components (Astro, plus a few React islands)
  data/              the typed record, its selectors, and the database reader (source-db.ts)
  lib/               pure logic: event lifecycle, city state, search, SEO, dates, map projection
  server/            server-only code: auth, members, projects, media, events, integrations
  scripts/           browser islands
  styles/            design tokens, fonts and global CSS
  middleware.ts      request middleware, including the projects.withclaude.in host
admin/               the staff app: a separate Astro app and Vercel project
db/                  shared by both apps: schema, migrations, importer, snapshot, DB clients
scripts/             operational CLIs (backfill, import, baserow, media) and dev tools (dev/)
tests/               Vitest suites
docs/                architecture notes, runbooks, Baserow setup, organiser guide
config/              Baserow config template and icon map
public/              static files served as-is
```

## Getting started

### Prerequisites

- Node.js 20 or later. CI runs Node 24.
- npm. The repo is an npm workspace, with `admin/` as its second package.
- Optional: a local PostgreSQL, if you're working on the database or the admin.

### Run the public site

```bash
npm install
npm run dev          # http://localhost:4321
```

Prerendered pages render from the TypeScript record in `src/data/` with no configuration.
On-demand pages read Neon on every request, so they need `DATABASE_URL`. These are the homepage,
events, cities, builders, ambassadors, projects, search, the gallery and the member area.

### Set up a local database

Copy `.env.example` to `.env`, then point `DATABASE_URL` at a local PostgreSQL. The driver is
picked from the hostname: Neon's serverless driver for `*.neon.tech`, node-postgres for anything
else.

```bash
createdb withclaude_dev
# DATABASE_URL="postgresql://postgres@127.0.0.1:5432/withclaude_dev"
npm run db:migrate   # apply the committed migrations
npm run db:import    # seed from src/data; idempotent
```

`db:import` is for local and staging databases. It rewrites events, projects and builders from the
TypeScript record, so running it against production would undo edits made through the admin,
Baserow or member accounts.

### Run the admin app

```bash
cp admin/.env.example admin/.env
npm run db:create-user -- --email you@example.com --name "Your Name" --role admin
npm run dev:admin    # http://localhost:4322
```

`BETTER_AUTH_URL` has to match how you reach the admin (`http://localhost:4322` locally). Magic
links are built from it, and every state-changing request is checked against it. Without
`RESEND_API_KEY` in development, the sign-in link is printed to the terminal instead of emailed.

|             | Local                   | Production                    |
| ----------- | ----------------------- | ----------------------------- |
| Public site | `http://localhost:4321` | `https://www.withclaude.in`   |
| Admin       | `http://localhost:4322` | `https://admin.withclaude.in` |

## Configuration

All variables are documented in `.env.example` and `admin/.env.example`. The main groups for the
public site:

| Variable                                                  | Purpose                                                              |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`                                            | Neon or local PostgreSQL. Needed by every on-demand page and command |
| `DATABASE_URL_READONLY`                                   | A SELECT-only role for the build snapshot. Recommended               |
| `DATA_SOURCE`                                             | `ts` (default, the rollback path) or `db` (what production runs)     |
| `SUBMISSION_IP_SALT`                                      | Salt for hashing submitter IPs. Rotating it resets rate limits       |
| `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_REPLY_TO`        | The submission acknowledgement email                                 |
| `PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET` | Member sign-in                                                       |
| `PRIVY_VERIFICATION_KEY`, `PUBLIC_PRIVY_LOGIN_METHODS`    | Optional Privy settings                                              |
| `BLOB_READ_WRITE_TOKEN`                                   | Vercel Blob, for member uploads. Injected by Vercel                  |
| `LUMA_CALENDAR_ID`, `LUMA_ICS_URL`                        | Optional overrides for the event feed                                |
| `LUMA_API_KEY`, `LUMA_WEBHOOK_SECRET`                     | Only for a calendar this account administers                         |
| `CRON_SECRET`, `VERCEL_DEPLOY_HOOK_URL`                   | Scheduled jobs and the nightly rebuild                               |
| `BASEROW_*`                                               | Content operations. See `docs/baserow/setup.md`                      |

Never prefix a secret with `PUBLIC_`. Astro inlines `PUBLIC_*` variables into the browser bundle.
The only `PUBLIC_` variables are non-secret settings: the two `PUBLIC_PRIVY_*` values here, and the
admin's optional `PUBLIC_SITE_URL`. `db/env.ts` refuses to start if a known secret is exposed with
that prefix, and `tests/security.test.ts` searches the built bundle for connection strings.

## Scripts

| Command                           | What it does                                                      |
| --------------------------------- | ----------------------------------------------------------------- |
| `npm run dev`                     | Public site dev server on port 4321                               |
| `npm run build`                   | Type-check with `astro check`, then build                         |
| `npm run preview`                 | Serve the built site                                              |
| `npm test`                        | Run the Vitest suite                                              |
| `npm run format` / `format:check` | Prettier                                                          |
| `npm run dev:admin`               | Admin dev server on port 4322                                     |
| `npm run build:admin`             | Build the admin                                                   |
| `npm run db:generate`             | Generate SQL in `db/migrations/` after a change to `db/schema.ts` |
| `npm run db:migrate`              | Apply migrations to `DATABASE_URL`                                |
| `npm run db:import`               | Copy `src/data` into the database. Local and staging only         |
| `npm run db:create-user`          | Create, update or deactivate an admin or editor account           |
| `npm run db:studio`               | Browse the database with Drizzle Studio                           |
| `npm run backfill:photos`         | Add committed event photographs to a database                     |
| `npm run import`                  | The event-archive importer: inspect, plan, apply, rollback        |
| `npm run baserow:check-schema`    | Check a Baserow workspace against the spec. Read-only             |
| `npm run baserow:discover`        | Build `BASEROW_CONFIG` from a workspace's live fields             |

npm runs `prebuild` (`db/snapshot.ts`) before every build. With `DATA_SOURCE=db` it reads the
database once and writes `.astro/dataset.json`. With `ts` it does nothing.

## Testing

```bash
npm test                                      # the whole suite
npx vitest run tests/<file>.test.ts           # one file
```

Database tests run against PGlite in-process, so they need no server, credentials or Docker.

- **Build-dependent suites.** `tests/security.test.ts`, `tests/admin-isolation.test.ts` and
  `tests/vercel-entrypoint.test.ts` inspect the build output. Run `npm run build` first or they
  fail.
- **The Neon suite.** `tests/equivalence-neon.test.ts` needs a live Neon credential. It's excluded
  unless you name it: `npx vitest run tests/equivalence-neon.test.ts`.
- **Memory.** Each database suite starts its own PGlite. CI limits Vitest to two workers. If you
  run several test processes on one machine, add `--no-file-parallelism`.
- **Windows.** The Vercel adapter's last build step creates symlinks and fails with `EPERM`
  without symlink rights. The build output is already written by then, so the tests still run.

## Continuous integration

`CI` (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`:

1. `npm ci`
2. `npm run build`, which type-checks first. It builds from the TypeScript record, so it needs no
   database and no secrets.
3. `npx vitest run --maxWorkers=2 --minWorkers=1`

`main` should require the `CI / check` status.

`Preview smoke` (`.github/workflows/preview-smoke.yml`) runs when Vercel reports a deployment of the
`with-claude` project through `repository_dispatch` (`vercel.deployment.success` and
`vercel.deployment.ready`). Chromium opens `/`, `/events/`, `/cities/`, `/projects/` and `/about/`
at three widths and fails on any of these:

- a non-200 status
- a page that ends on another origin, such as Vercel's login
- horizontal overflow
- a missing or repeated `<main>` or `<h1>`
- an uncaught script error

Console noise alone doesn't fail it. The result is posted to the deployment's commit as
`Vercel - with-claude: smoke`, and the screenshots are attached as the `preview-screenshots`
artifact. GitHub reads `repository_dispatch` workflows from `main` only, so a pull request can't
change what this check runs.

One-time setup for maintainers:

1. **Vercel, both projects:** under Settings → Git, keep `repository_dispatch` events on for
   `with-claude`, and turn `deployment_status` events off for both projects. GitHub runs a
   `deployment_status` workflow from the deployed commit, so a fork's preview could otherwise run
   its own workflow with this repository's secrets.
2. **Deployment protection:** create a Protection Bypass for Automation secret in Vercel and store
   it in GitHub Actions as `VERCEL_AUTOMATION_BYPASS_SECRET`. The check sends it to the preview's
   own origin only, never along a redirect.
3. **First run:** open the run's `payload` job and confirm it prints `environment: preview` and
   `project.name: with-claude`. The smoke job filters on those values and skips silently if they
   differ.
4. **Production gate:** under Vercel Settings → Build and Deployment → Deployment Checks, import
   `check`, and add `smoke` once a production run has passed. A production build then goes live
   only after both pass on its commit.

The same script runs locally against any URL:

```bash
BASE=http://localhost:4321 PAGES=/,/events/,/projects/ STRICT=1 node scripts/dev/visual-review.mjs
```

`scripts/dev/share-cards-audit.mjs` checks the event share cards on a deployment. It's run by hand,
because event pages render on demand and a local build has no event HTML to read.

```bash
BASE=https://www.withclaude.in node scripts/dev/share-cards-audit.mjs
```

## Deployment

The repository deploys to two Vercel projects:

| Project             | Root      | Serves                                           |
| ------------------- | --------- | ------------------------------------------------ |
| `with-claude`       | repo root | `www.withclaude.in` and `projects.withclaude.in` |
| `with-claude-admin` | `admin`   | `admin.withclaude.in`                            |

The admin project needs **Include files outside the root directory** turned on, because it imports
`../db`. Its build command is `npm run build`, run inside `admin`.

The public site is static first. Pages are files on the CDN unless a route sets
`export const prerender = false`. The list of on-demand routes is enumerated in
`tests/admin-isolation.test.ts`, which fails when a new one isn't recorded there.

### Scheduled jobs

Defined in `vercel.json`. Times are UTC, with IST in brackets.

| Path                          | Schedule      | Job                                               |
| ----------------------------- | ------------- | ------------------------------------------------- |
| `/api/cron/baserow-reconcile` | 21:15 (02:45) | Reconcile Baserow content into Neon, when enabled |
| `/api/cron/events-sync`       | 21:45 (03:15) | Sync events from the Luma feed                    |
| `/api/cron/rebuild`           | 22:30 (04:00) | Trigger a production build through a deploy hook  |

The rebuild exists because event lifecycle is computed from the clock, so prerendered pages go
stale without a commit. Create a deploy hook under Project Settings → Git → Deploy Hooks and set
`VERCEL_DEPLOY_HOOK_URL`. Vercel sets `CRON_SECRET`, and the routes refuse to run without it.

### Database changes

Migrations are committed SQL in `db/migrations/`, and they're the only way the production schema
changes. A maintainer applies them with `npm run db:migrate`.

**Apply a migration before deploying code that reads its columns.** A whole-row Drizzle select
names every column in `db/schema.ts`, so new code fails on a database that doesn't have the column
yet. Additive migrations are safe to run first, because the code already deployed never names the
new column.

### Admin environment

Every secret here is server-side. `PUBLIC_SITE_URL` is the only `PUBLIC_` setting, and it isn't a
secret:

| Variable             | Notes                                                                |
| -------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`       | The same database as the public site. One schema, one database       |
| `BETTER_AUTH_SECRET` | 32 random bytes. Rotating it signs everybody out                     |
| `BETTER_AUTH_URL`    | `https://admin.withclaude.in`, no trailing slash. Must match exactly |
| `RESEND_API_KEY`     | Required in production, where sign-in fails without it               |
| `RESEND_FROM`        | An address on a domain verified in Resend                            |
| `RESEND_REPLY_TO`    | Optional                                                             |
| `PUBLIC_SITE_URL`    | Optional. The public site's origin; defaults to the production URL   |

Create the first account from a machine with the production `DATABASE_URL`:

```bash
npm run db:create-user -- --email you@example.com --name "Your Name" --role admin
```

There's no sign-up and no web form for creating accounts. That's deliberate: admin access is the
project's main security boundary.

If the domain changes, update `site` in `astro.config.mjs`. Canonical URLs, Open Graph tags and the
sitemap read from it. After a brand change, regenerate the share card with `node scripts/og.mjs`.

## Architecture

`docs/architecture.md` has the detailed notes. In short:

**Data.** `DATA_SOURCE` selects where the public record comes from: `ts` reads the authored
TypeScript in `src/data/`, and `db` reads Neon, which is what production runs. Both produce the
same `RecordSet` (`src/data/source.ts`), and every selector sits above that seam, so the two
sources are checked by comparing one value (`tests/equivalence.test.ts`). With `db`, prerendered
pages read a snapshot that `db/snapshot.ts` takes once before the build. On-demand pages read Neon
per request through `loadLiveRecords()` in `src/server/directory.ts`. That function currently
limits live event listings to events credited to the Bhopal Ambassador.

**Identity.** Members sign in with Privy. `src/server/auth/privy.ts` is the only code that turns a
token into an identity, and it returns the Privy DID and nothing else. Staff use Better Auth in
the separate admin app, where role and active status are re-read from the database on every
request.

**Content authority.** Every field has exactly one writer: the Luma feed, Baserow, members, or
editors in the admin. `docs/content-authority.md` has the full table, and the projection code
enforces it.

**Media.** Member uploads go to Vercel Blob. `media.consent` records that the person shown allowed
publication here, and `media.consent_basis` records how: `self_upload` or `registration_terms`. A
taken-down image (`status = 'deleted'` or a set `deleted_at`) is excluded from every public read.

**Isolation.** The admin is a separate application with its own build. It shares `db/` with the
public site and nothing else: no cookie, no bundle. `tests/admin-isolation.test.ts` checks the
built public bundle for auth code, sessions, credentials and admin routes.

## Governance and data integrity

The data model keeps three kinds of participation apart:

| Kind                      | Who                          | How it's granted              | How it appears                         |
| ------------------------- | ---------------------------- | ----------------------------- | -------------------------------------- |
| Ambassador-led activity   | Claude Community Ambassadors | Appointed by Anthropic        | The only filled chip on the site       |
| Builders and contributors | Anyone building with Claude  | Self-submitted, then reviewed | An outline chip in the builder index   |
| City interest             | People who live there        | Registered by anyone          | A signal on the atlas, never a chapter |

These rules are enforced in code and in the schema, not by convention:

- **Ambassador status comes from a verified record.** An event is Ambassador-led because its host
  resolves to a published ambassador, and every ambassador row needs a non-empty `verified_via`.
  There's no flag to set, and `builders.roles` can't contain `ambassador`.
- **Cities have no status column.** `cityState()` derives one of four states (`ambassador-led`,
  `event-activity`, `community-interest`, `discovery`) from verified records.
- **Nothing self-publishes.** Submissions arrive as inbox items with status `pending`. Public reads
  return only published rows that moderation hasn't held or removed.
- **Review is recorded.** Every submission status change goes through `transitionSubmission()` in
  `admin/src/server/transitions.ts`, which writes the change and its audit entry in one
  transaction. `audit_log` is append-only: database triggers reject UPDATE, DELETE and TRUNCATE.
- **Moderation is reversible.** Restrict, restore, archive and delete map to one table in
  `admin/src/server/moderation.ts`. A restore clears the deletion tombstone as well as the state.

There's deliberately no "start a chapter" flow. Hosting Claude Community events means becoming a
Claude Community Ambassador, which is Anthropic's programme, and the site links there.

`tests/data.test.ts` enforces the honesty rules on the record. A city can't be Ambassador-led
without a real Ambassador record. Every Ambassador must say how the status was verified, every
record must carry a moderation status, and community-written pieces need an author with a
credential.

## Data operations

Production reads Neon, so most content arrives through the running system:

- events through the Luma sync
- projects and profiles from members
- curated changes through the admin or Baserow

The TypeScript record in `src/data/` is the seed and the rollback path. A change there reaches
production only through a reviewed import or backfill, and only maintainers run those against
production.

### Backfilling event photographs

Committing a photograph to `src/assets/events/` and listing it on its event in `src/data/events.ts`
puts it in the repository, not in the database. `backfill:photos` adds those photographs without
running the full importer:

```bash
npm run backfill:photos -- rehearse     # dry run against PGlite seeded to the live state
npm run backfill:photos -- plan         # dry run against DATABASE_URL; writes nothing
npm run backfill:photos -- apply --yes  # write, after printing the delta; saves a receipt in imports/
npm run backfill:photos -- rollback --receipt imports/<file>.json --yes
```

- It's insert-only by default. `--with-dimensions` also updates width and height on existing rows.
- A non-local `DATABASE_URL` needs `--allow-remote-db`.
- `apply` refuses when the dry run flags a position clash or a path the asset registry wouldn't
  resolve.
- New rows record `consent = true` with `consent_basis = 'registration_terms'`.
- Undo with `rollback --receipt`. It reports what it kept and why, and it never deletes a media row
  that something else has adopted since, such as a cover, logo or avatar.

Read the `plan` output before passing `--yes`.

### Importing an event archive

`npm run import` takes a spreadsheet export through `inspect`, `plan`, `apply` and `rollback`.
Nothing reaches the database before `apply --yes`. Past runs are documented in `docs/imports/`.

## Design, accessibility and search

**Design system.** `src/styles/tokens.css` holds every colour, size and duration, and nothing else
holds raw values. Token names describe roles, not colours: `--paper` is the page ground and `--ink`
the strongest text in either theme. Shared classes (containers, the heading pair, buttons, chips,
fields) live in `src/styles/primitives.css`, and components don't redefine them. Read the tokens
before changing any UI.

**Themes.** Dark is the default on every public page. The server renders `data-theme="dark"`, so
with JavaScript off the site is dark and complete and the theme toggle is hidden. Cream is the
visitor's choice: the toggle in the masthead switches the theme and saves it as `wc-theme` in
`localStorage`, and an inline script in the `<head>` of `src/layouts/Base.astro` applies the saved
choice before first paint. The site doesn't follow the device's colour scheme. Everything under
`/me/` is locked light and hides the toggle, and print is always light. Every colour token has a
literal value in the dark, light and print blocks; `tests/theme.test.ts` checks that, along with the
head script and the `/me/` lock.

**Shape and type.** Buttons, chips, fields and icon buttons are pills. The primary button is clay
with a glow and dark text, and the rest are outlined. Clay text uses `--clay-deep`, the text-safe
clay, and text on a clay fill uses `--btn-ink`. Headings are Anthropic Serif Display Light, and a
section opens with a serif heading over one sentence of grey sans. Titles and controls use Anthropic
Sans Display Semibold, and body text is Inter. The serif never goes below 21px, and no text goes
below 15px (`--t-small`, checked by `tests/theme.test.ts`). Fraunces sets the wordmark and nothing
else. There's no monospace anywhere. The fonts are defined in `src/styles/fonts.css`.

**Motion.** Animation either plays once on load or follows the scroll, and nothing loops:
`tests/theme.test.ts` fails on any `infinite` in `src`. The hero's sunrise and headline play once on
load, and the headline only rises and sharpens, so it is never below full opacity. The live dot, the
next-event pulse and the lead city's ring on the map run twice and stop. Reveals, and the map's pins
and routes, run on CSS scroll timelines inside both `prefers-reduced-motion: no-preference` and
`@supports (animation-timeline: view())`. The static state is the finished state, so reduced-motion
visitors and browsers without scroll timelines get the complete page, and with reduced motion every
remaining animation and transition is cut to near zero. The film grain over the page is a static
layer.

**The India map** (`src/components/CityAtlas.astro`) is drawn from DataMeet's state boundaries,
which follow the official Survey of India outline, simplified and reprojected by
`scripts/map/build.sh` into `src/data/india-map.ts`. `tests/india-map.test.ts` checks the official
boundary: Gilgit, Aksai Chin and the Shaksgam valley must fall inside it and Lahore outside, and the
small islands must survive simplification. The credit for DataMeet and the Creative Commons
Attribution 2.5 India licence is on /about/, with both links. City dots are placed
from each city's latitude and longitude in three kinds: the lead city glows, cities that have held
an event are lit, and every other city is a quiet dot. Colours come only from the `--map-*` tokens,
so the map works in both themes.

**Accessibility.** Semantic landmarks, a skip link, visible focus rings in both themes, comfortable
touch targets, and `prefers-reduced-motion` honoured throughout. The map is a named picture
(`role="img"` with an `aria-label`), so nothing in it is focusable; the city links sit beside it.
`node scripts/audit.mjs` checks heading order, landmarks, alt text, link names, overflow, focus,
touch targets, the map's name across the routes and its credit on /about/.

**Search.** `/discover` uses one index over the whole record, built from the same selectors the
pages read. There's no model in it. `parseQuery()` reads cities, event formats and Claude surfaces
out of the data deterministically, and `runSearch()` only returns records that exist. The matcher
in `src/lib/search-core.ts` runs both on the server and in the browser, so there's one scoring
implementation.

**SEO.** `src/lib/seo.ts` emits structured data that matches the visible page. Authors are omitted
rather than invented. `src/lib/indexable.ts` decides what deserves indexing: a city with no
events, builders, projects or stories is `noindex` and left out of the sitemap.

## Contributing

- Branch from an up-to-date `main` and open a pull request. Don't push to `main` directly, and don't
  force-push shared branches.
- A pull request needs a green `CI / check`. Run `npm run build` and the tests you touched locally
  first.
- Add or update tests with behaviour changes. Prefer tests that exercise behaviour against PGlite
  over tests that match source text.
- Format the files you change with Prettier (`npx prettier --write <files>`).
- Follow the design tokens and primitives for any UI change.
- Never write to the production database from a branch. Migrations, backfills and imports against
  production are run by a maintainer, from reviewed code, after a dry run.

## Security

- Secrets stay server-side, as described in [Configuration](#configuration).
- Admin access is granted only by `npm run db:create-user`. Sign-in never reveals whether an
  address has an account.
- State-changing admin requests are checked against the admin's own origin.
- Submitter IP addresses are salted and hashed before storage. A submitter's email address never
  appears on the public site, and the admin queue doesn't fetch it.

Please report security issues privately to the maintainers, not in a public issue.

## Relationship to Anthropic

This is an independent, non-commercial, volunteer-run community. It isn't an Anthropic property,
programme or endorsement. The affiliation statement lives in `site.affiliation` in
`src/data/site.ts` and renders in the footer and on `/about` and `/community`. The structured data
has no `parentOrganization`, `sponsor` or `memberOf` pointing at Anthropic.

Every "Become a Claude Community Ambassador" link reads `official.ambassadorProgramUrl` in
`src/data/site.ts` and goes to <https://claude.com/community/ambassadors>.

## Credits

Community events in Bhopal are organised by [The Origin Guild](https://t.me/tog_guild). Event
photography and the event record come from that community. City photography carries its original
Wikimedia Commons and Unsplash attribution; see `src/assets/city/`.
