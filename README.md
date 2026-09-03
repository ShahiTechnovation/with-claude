# WITH CLAUDE

**India is building.**

Where people across India meet, learn, experiment and build with Claude — a living discovery layer
for events, cities, builders, projects and stories in one place.

Target domain: **withclaude.in**

---

## What this is

Not a meetup landing page, and not a chapter directory. The product is a _discovery layer_ — an
editorial, cartographic index of a builder ecosystem, architected so that Bhopal is one node in a
network rather than the whole architecture.

It exists to answer six questions: what is happening, where, who is building, what they made, what
you can join, and how you contribute.

Three rules shape every decision in here:

1. **Nothing is invented.** Every event, date, venue, photograph and credit comes from the real
   community record. Where an archive is empty — projects, written stories — it renders an honest,
   designed empty state instead of filler. See [Content honesty](#content-honesty).
2. **One source of truth.** No page decides what "next" means, what state an event is in, or what
   is happening in a city. That lives in `src/lib/status.ts`, `src/lib/city.ts` and
   `src/data/index.ts`, and everything reads from it.
3. **It works without JavaScript.** Motion, the atlas readout, the archive filters, the join flow
   and the submission panels are all additive. With scripts blocked the page is complete, readable
   and navigable, and no control is dead.

## Run it

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # type-check, then build to dist/
npm run preview    # serve the built site
npm test           # vitest
npm run format     # prettier
```

Node 20+ (CI uses 22).

## The governance model

This is the part that is structural rather than cosmetic, and the part to not quietly undo.

There are three distinct kinds of thing on this site, and the data model keeps them apart:

| Kind                          | Who                          | How it is granted             | How it appears                         |
| ----------------------------- | ---------------------------- | ----------------------------- | -------------------------------------- |
| **Ambassador-led activity**   | Claude Community Ambassadors | Appointed by Anthropic        | The only filled chip on the site       |
| **Builders and contributors** | Anyone building with Claude  | Self-submitted, then reviewed | An outline chip in the builder index   |
| **City interest**             | People who live there        | Registered by anyone          | A signal on the atlas, never a chapter |

Three consequences are enforced by the types, not by editorial discipline:

- **An event is Ambassador-led because `host.ambassadorSlug` resolves to a published `Ambassador`
  record.** There is no `verified: true` flag to set. `src/data/ambassadors.ts` is the single most
  consequential file in the repo, and every entry must carry `verifiedVia` — if you cannot say how
  you know, there is no record to write.
- **A `City` record contains no community status at all.** There is no `active` field and no way to
  promote a city by editing `cities.ts`. `cityState()` in `src/lib/city.ts` derives one of four
  states from verified records: `ambassador-led`, `event-activity`, `community-interest`,
  `discovery`. A city with nothing verified derives to `discovery`, and the page says so plainly.
- **Submissions enter at `status: 'pending'`.** `isPublic()` gates everything the site renders, so
  nothing self-publishes. The `ambassador` role in `builders.ts` is ignored by the UI — it is read
  from `ambassadors.ts` — so writing it by hand achieves nothing, which is the point.

There is deliberately no "start a chapter" anywhere on this site. Hosting Claude Community events
means becoming a Claude Community Ambassador, which is Anthropic's programme; the HOST path routes
there and says so.

## Stack

- **Astro 5 + TypeScript**, static output. No React, no UI framework — the four interactive islands
  (atlas, archive filters, join flow, submission panels) are a few dozen lines of vanilla TS each,
  which is smaller and faster than shipping a runtime for them.
- **Self-hosted fonts** via Fontsource (no external requests): Fraunces Variable (WONK axis only —
  the expressive axis, at a third the file size of the full build), Inter Variable, IBM Plex Mono.
- **`astro:assets`** for responsive images (WebP, explicit dimensions, lazy below the fold).
- Zero runtime dependencies beyond Astro itself.

## Architecture

```
src/
  data/            the record — plain typed modules, no build-tool imports
    types.ts         the domain model, and the governance rules it encodes
    ambassadors.ts   verified Ambassadors. Every entry needs `verifiedVia`.
    events.ts        11 real events, each with a resolvable host
    cities.ts        14 cities — coordinates and context, no status
    builders.ts      the open index
    projects.ts      empty on purpose
    stories.ts       empty on purpose
    forms.ts         the three submission forms and their fields
    site.ts          brand, affiliation, official links, participation paths, FAQ
    index.ts         every derived selector the pages read
  lib/
    status.ts        THE event lifecycle machine — computed, never authored
    city.ts          THE city state machine — derived from verified records
    datetime.ts      IST-pinned date and time formatting
    geo.ts           the map projection, scale bar and coordinate stamp
    atlas.ts         the shape the atlas serialises to its island
    images.ts        resolves data-layer image keys to optimised assets
  styles/
    tokens.css       every colour, size, duration. Nothing else holds a raw value
    base.css         reset, document typography, a11y primitives, the reveal system
    primitives.css   containers, meridian, buttons, chips, pips, plates, fields
  components/      one concern each, styles scoped alongside
  scripts/         the four islands
  layouts/Base.astro   head, SEO, JSON-LD, masthead, meridian, footer
  pages/           routes
tests/             vitest — lifecycle logic, date handling, data and governance integrity
scripts/           dev tooling (screenshots, audit, OG card). Not part of the build.
```

### Routes

| Route              | State                                                              |
| ------------------ | ------------------------------------------------------------------ |
| `/`                | The homepage — eleven movements, four grounds                      |
| `/events`          | Next event + the filterable archive                                |
| `/events/[slug]`   | 11 pages, one per event                                            |
| `/cities`          | The atlas + the index + city registration                          |
| `/cities/[slug]`   | 14 pages; live and quiet cities get genuinely different treatments |
| `/builders`        | The open index + submission + the photographic record              |
| `/builders/[slug]` | Profile, honest about what the entry is missing                    |
| `/projects`        | The archive (empty) + submission                                   |
| `/projects/[slug]` | Generates nothing today; ready for the first real submission       |
| `/stories`         | The photographic record + what a written piece would be            |
| `/stories/[slug]`  | Generates nothing today; wired into the same graph                 |
| `/join`            | Three questions, the ways in, and all three submission forms       |
| `/community`       | The governance model, Ambassadors, city states, FAQ, partners      |
| `/404`             | —                                                                  |

## The design system

Read `src/styles/tokens.css` first — it is the whole system, and the only file with raw values.

**Ground.** Warm paper (`--paper`) with ink type. Sections that flip dark add `.on-night` (or
`.on-deep` for the one darkest moment per page), which remaps the semantic tokens rather than
overriding colours one by one, so everything inside keeps working unchanged. The homepage runs
light → sunk → light → **dark** → light → **deepest** → image-led → sunk → light → raised →
**dark** so the page has rhythm rather than eleven identically-weighted panels.

**Colour discipline.** Clay (`--clay`) is reserved for live/next state, the meridian, and the mark.
It is never decoration. There is a hard contrast rule written into the token file:

- `--clay` on paper is 2.7:1 — **fill only, never text**
- `--clay-deep` on paper is 5.6:1 — safe for text
- `--clay` on night is 5.9:1 — safe for text

**Type.** Fraunces (display, `WONK 1` — the axis that gives it a voice), Inter (body), IBM Plex
Mono (all metadata, labels and coordinates). The scale is deliberately gapped rather than modular.
It renders at true 100% zoom: an earlier build applied `zoom: 0.8` to the whole document to fake
density, which quietly made every rem value a lie and pushed metadata under 11px.

**Shape.** Hairlines and right angles. Nothing on this site is a pill; the largest radius is 3px.

**The wordmark.** Two words, two weights: WITH is the light italic and CLAUDE is the heavy roman, so
the relationship reads before the words do. `with` is the brand's recurring device — MADE WITH
CLAUDE, WITH YOUR CITY — and it earns that by being the first word of the name, which is also why
it is not sprayed across every heading.

### The meridian

One clay thread runs the left rail and fills as you travel down the page. It no longer carries
numbered section ticks: numbering every movement turned each one into an entry in the same
scientific report, which is the sameness this redesign had to lose. Sections now differ by ground,
width and air, and each writes its own eyebrow.

### The atlas

`src/lib/geo.ts`, `components/CityAtlas.astro`, `src/scripts/atlas.ts`.

The map is **a coordinate plot, not a traced outline**, with a real scale bar and a north mark to
say so. Deliberate for three reasons: every point is honest; it sidesteps depicting national
boundaries, which is a regulated matter in India and not something a community site should get
wrong; and it reads as cartography rather than a Google Maps clone.

What it communicates is community state, and the four states are separated by **form before
colour** — a filled station, an open ring, a solid dot, a hairline — so the plate still reads in
monochrome and for a colour-blind reader. The legend shows every state with its count, including
the zeros.

Interaction differs by input, on purpose:

- **Fine pointer** — hover or focus previews a city in the readout; clicking navigates.
- **Coarse pointer, phone width** — the plate becomes a drawing and the city list beside it is the
  control. Mumbai and Pune are 27 plate units apart, which at 390px is 14 real pixels: any target
  big enough for a fingertip swallows its neighbour and the wrong city opens. The list carries
  every city as a full-width row instead. Keyboard focus still drives the readout.

## Content honesty

| Area                      | State                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- |
| Events                    | 11 real events, real registration links, real venues                          |
| Ambassadors               | 1 — Aniket Sahu, Bhopal, with `verifiedVia` recorded                          |
| Cities                    | 14 plotted; 1 Ambassador-led, 13 `discovery` and explicitly labelled as such  |
| Builders                  | 2 — publicly credited workshop leads. No invented bios, portraits or links.   |
| Projects                  | **Empty.** No verified submissions exist yet.                                 |
| Stories                   | **Empty** of written pieces. Runs on the photographic record instead.         |
| Member / prototype counts | Community-reported, kept out of the derived counts, rendered with the source. |
| `createdAt` timestamps    | Omitted where unknown, so the activity feed can never show invented activity. |

`tests/data.test.ts` enforces this. A city cannot reach `ambassador-led` without a real Ambassador
record; a city with no events cannot claim an organiser or report figures; every Ambassador must
say how the status was verified; every record must carry a moderation status.

The empty archives are designed, not broken. `/projects` states the fact, says what an entry holds
so a submitter knows what is being asked, and gives one action. Add one real project to
`src/data/projects.ts` and the grid takes over automatically.

### Submissions

There is no backend, and inventing one would be worse than not having one. `SubmitPanel` composes
what you typed into a clean, complete block of text and hands it to you to send through the channel
the community actually reads — you press send, so nothing leaves the browser without you doing it.
When a real endpoint exists, set `endpoint` on the form in `src/data/forms.ts` and the panel posts
to it instead. Nothing else changes.

### Relationship to Anthropic

This is an independent, non-commercial, volunteer-run community. It is **not** an Anthropic
property, programme or endorsement. That line lives in `site.affiliation` and renders in the
footer, the FAQ, `/community` and the JSON-LD — where there is deliberately no
`parentOrganization`, `sponsor` or `memberOf` pointing at Anthropic, because asserting a
relationship in structured data is still asserting it.

Every "Become a Claude Community Ambassador" CTA — in the participation paths, on `/community`, on
every quiet city page, and in the footer — reads `official.ambassadorProgramUrl` in
`src/data/site.ts` and goes to <https://claude.com/community/ambassadors>. That field is typed as a
required `string` rather than an optional one specifically so no fallback can exist: someone who
wants to host events should land on the programme page, not on a homepage to navigate from.

## Adding to the record

**A new event** — add one entry to `src/data/events.ts`. Nothing else: the hero, the masthead chip,
the meta description, the JSON-LD, the archive and every status badge derive from it. There is no
"featured" flag to move and no date to update in a second place.

**A new Ambassador** — add to `src/data/ambassadors.ts` with a real `verifiedVia`. That single edit
is what turns their city Ambassador-led and gives their events the verified treatment.

**A project, builder or story** — fill in the array with `status: 'published'`. The UI switches out
of its empty state on its own, and the relevant filters appear because facets are built from what
is actually there.

## Accessibility

Semantic landmarks and a logical heading order; a skip link; visible 2px focus rings that are never
styled away; every atlas node reachable by keyboard with the readout responding to focus as well as
hover; no hover-only interaction anywhere; `prefers-reduced-motion` honoured throughout (the reveal
system only displaces content once JS confirms motion is wanted, so with it off the page is simply
finished); comfortable touch targets; AA contrast, with the clay rule above enforcing the one place
it would otherwise slip.

`node scripts/audit.mjs` checks heading order, landmarks, alt text, link names, overflow, focus,
touch targets and the no-JS render across every route.

## Deploying

Netlify (`netlify.toml`) and Vercel (`vercel.json`) are both configured: build `npm run build`,
publish `dist`. Nothing server-side.

Set `site` in `astro.config.mjs` if the domain changes — canonical URLs, Open Graph tags and the
sitemap all read from it. Regenerate the share card after a brand change: `node scripts/og.mjs`.

## Dev tooling

`scripts/shoot.mjs` and `scripts/shoot-pages.mjs` screenshot the site across the breakpoints the
design targets, using Playwright. `scripts/audit.mjs` runs the structural accessibility pass.
`scripts/slice.py` cuts a tall full-page capture into readable bands. None are part of the build.

## Credits

Community events in Bhopal are organised by [The Origin Guild](https://t.me/tog_guild). Event
photography and the event record come from that community. City photography carries its original
Wikimedia Commons and Unsplash attribution — see `src/assets/city/`.
