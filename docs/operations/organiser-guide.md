# Organiser guide — events and past projects

For the people who run WITH CLAUDE events and keep the archive. You edit in
Baserow; the website updates itself. You never need to touch code.

## Add an event

1. In **Events**, add a row. Fill **Key** with something unique and permanent
   (`evt-<city>-<name>-<yyyy-mm>`), then title, summary, city, venue, date,
   start time (24-hour, local), format.
2. Leave **Editorial status** = `draft` while you work. Set `published` when
   it is ready; it appears on the site within about two minutes.
3. Cancelled? Set **Lifecycle** = `cancelled`. Do not delete the row — the
   page stays as an honest record and the Register button disappears.

An event that came from Luma is already on the site. To start editing it in
Baserow, add a row and put the event's Neon ID in **Neon ID** (ask an admin).
From then on Baserow is where its details are edited; later Luma changes are
kept for review instead of overwriting yours.

## Import projects from a past event

Run this with an admin, on a laptop, with the spreadsheet saved in `imports/`
(never in the repository):

```bash
npm run import -- inspect imports/day.xlsx                    # what is in the file
cp scripts/import/mapping.example.json imports/day-mapping.json # then edit it
npm run import -- plan imports/day.xlsx --mapping imports/day-mapping.json
```

Edit the mapping so each column you want is named; **any column you do not
name is not imported** — emails, phones and private answers stay out. Choose
the credit policy honestly: use a consent column if the form asked "may we
show your name?", otherwise `no-person-credits` and rely on team names.

Open `imports/<batch>/plan.md`. It lists what would be created, updated or
left alone, possible duplicates, and what each project is missing. In
`decisions.json`, change `hold` to `apply` or `skip` for each item under
review. Then:

```bash
npm run import -- apply --plan imports/<batch>/plan.json --yes
```

Imported projects arrive as **drafts**. Add `--publish` only for a batch you
have reviewed; even then a project publishes only if it has a summary, its
event and at least one public link (live, repository, video or download). A
team credit is not required: names are published only with permission.

Running the same import again creates nothing new. A corrected spreadsheet
updates the same rows (a blank cell never erases a value). To undo a batch:

```bash
npm run import -- rollback --batch <batch-id> --yes
```

Rollback leaves alone anything you edited in Baserow since, and anything a
member has claimed.

## The September 2026 Bhopal archive (Impact Lab 2 and Fable 5.1)

These two forms have their own source adapter
(`scripts/import/sources/event-archive-2026-09/`) because they do not have one
title column and one person per row. Every row has a reviewed decision in
`editorial.ts` (title where the form had none, a card summary, a category,
holds); the adapter refuses a sheet whose rows no longer match those decisions,
so a reordered or revised workbook cannot attach a summary to the wrong
project. The full row-by-row record is `docs/imports/2026-09-event-archive.md`.

This workspace (Baserow database 578390) has three tables — **Projects**
(1236064), **Events** (1236080) and **ProjectCredits** (1236082) — and no
Cities table: each **City** field is text holding the Neon city slug
(`bhopal`). The fields must exist first; see
[the setup guide](../baserow/setup.md#this-workspace-database-578390). A
database token can only read and write rows, never create fields.

1. Create the fields in the Baserow UI, then map them (by name, once) and
   check them:

   ```bash
   . .dev-auth/baserow.env.sh            # the token, git-ignored
   npm run baserow:discover              # writes .dev-auth/baserow.config.json
   export BASEROW_CONFIG="$(cat .dev-auth/baserow.config.json)"
   npm run baserow:check-schema          # must print ok for all three tables
   ```

2. Rehearse against a local mirror of the real schema, then run it for real.
   Each run, in order: match or create the two canonical **Events** rows
   (by key; a new row adopts the production Neon event and carries the held
   date), snapshot every existing row, plan, write **Projects**, write
   **ProjectCredits** (none — no consent to show names is on record), read
   everything back and verify it, then validate the existing sync on a fresh
   local database clone and prove a second run changes nothing:

   ```bash
   npm run baserow:discover -- --fields-file imports/baserow-live/fields.json --out imports/baserow-live/real.config.json
   MODE=mirror FIELDS=imports/baserow-live/fields.json CONFIG_FILE=imports/baserow-live/real.config.json      scripts/dev/run-baserow-migration.sh "<Impact Lab 2.xlsx>" "<Fable 5.1.xlsx>"
   MODE=real scripts/dev/run-baserow-migration.sh "<Impact Lab 2.xlsx>" "<Fable 5.1.xlsx>"
   ```

   An interrupted run resumes: every write is ledgered before it is sent, and
   a create that may have landed is looked up by its key before anything is
   retried. `imports/<batch>/apply-manifest.json` lists every row the batch
   created; `baserow-before.json` is the snapshot taken before it wrote;
   `baserow-reconciliation.md` accounts for all 100 source rows.

3. Re-running an import never overwrites your work. A field is updated only
   while it still holds exactly what the importer last wrote there; anything
   you changed in Baserow is reported as "kept organiser edit" and left alone.
   Editorial status is never changed on an existing row.

4. The rows arrive in Neon through the normal sync once it is switched on for
   the target environment (webhook, cron, or *Reconcile now* in the admin).
   Held projects are drafts; their **Review notes** say what to decide. Set
   **Editorial status** to `published` when it is resolved.

The two Events rows mirror the Neon events they adopt. Edit them in Baserow
from then on — including the Fable title and summary, which still carry the
Luma feed's wording ("Bhopal | Claude Code Build Day - Fable 5.1", "Get
up-to-date information at …").

## Check missing fields

Use the *Needs information* and *Missing covers* views in Baserow. In the
admin, **Content sync → Needs attention** lists rows that could not be
applied (quarantined — the last good version stays live) or are held from
publication, with the reason.

## Preview before publishing

Drafts are not public. A member account with the moderator role can open
`/projects/<slug>/` for a draft project; that view is private and never
cached. Ask an admin to grant the role. Draft **events** cannot be previewed
on the site yet — check them in Baserow before publishing.

## Publish, archive, correct

- Publish: set **Editorial status** = `published`.
- Take down: set `archived` (reversible). Deleting the row also archives it.
- Correct: edit the row. Titles and text update in place; a published slug
  never changes, so shared links keep working.
- Something urgent (abuse, privacy): ask a moderator — moderation applies
  immediately and Baserow cannot override it.

## Check that the sync is working

Admin → **Content sync**: last successful run, pending/failed jobs, rows by
state. *Reconcile now* re-checks every row; *Retry failed jobs* after fixing
a configuration problem.

## Process a claim

When someone says "that's my project", they use **Is this your project?** on
its page. Admin → **Claims** shows their evidence. Approve only what you can
verify (their GitHub, an organiser who was there, a teammate). A matching
name is not proof. Approving makes them the owner: from then on they edit it
on the website, and Baserow edits to that project are ignored.
