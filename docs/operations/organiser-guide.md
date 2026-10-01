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
event, a team credit and at least one link.

Running the same import again creates nothing new. A corrected spreadsheet
updates the same rows (a blank cell never erases a value). To undo a batch:

```bash
npm run import -- rollback --batch <batch-id> --yes
```

Rollback leaves alone anything you edited in Baserow since, and anything a
member has claimed.

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
