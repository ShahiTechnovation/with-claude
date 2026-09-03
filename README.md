# Claude India

**Where India builds with Claude.**

A community record of the people across India who meet, learn and ship with Claude — events,
cities, builders, projects and stories in one place.

Target domain: **claudeindia.in**

---

## What this is

Not a meetup landing page. The product is a *record*: an editorial, cartographic index of a
builder ecosystem, designed so that Bhopal is simply the first chapter rather than the whole
architecture.

Three rules shape every decision in here:

1. **Nothing is invented.** Every event, date, venue, photograph and credit comes from the real
   Bhopal community record. Where an archive is empty — projects, written stories — it renders an
   honest, designed empty state instead of filler. See [Content honesty](#content-honesty).
2. **One source of truth.** No page decides what "next" means or what state an event is in. That
   lives in `src/lib/status.ts` and `src/data/index.ts`, and everything reads from it.
3. **It works without JavaScript.** Motion, the map readout and the mobile drawer are additive.
   With scripts blocked the page is complete, readable and navigable.

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

## Stack

- **Astro 5 + TypeScript**, static output. No React, no UI framework — the two interactive pieces
  (the map readout and the nav drawer) are a few dozen lines of vanilla TS each, which is smaller
  and faster than shipping a runtime for them.
- **Self-hosted fonts** via Fontsource (no external requests): Fraunces Variable (WONK axis only —
  the expressive axis, at a third the file size of the full build), Inter Variable, IBM Plex Mono.
- **`astro:assets`** for responsive images (WebP, explicit dimensions, lazy below the fold).
- Zero runtime dependencies beyond Astro itself.

## Architecture

```
src/
  data/          the record — plain typed modules, no build-tool imports
    types.ts       the domain model
    events.ts      11 real events
    cities.ts      14 cities, 1 active
    builders.ts    the roster
    projects.ts    empty on purpose
    stories.ts     empty on purpose
    site.ts        site copy, socials, partners, FAQ, ways in
    index.ts       every derived selector the pages read
  lib/
    status.ts      THE event state machine — the single source of truth
    datetime.ts    IST-pinned date and time formatting
    geo.ts         the map projection and the coordinate stamp
    images.ts      resolves data-layer image keys to optimised assets
  styles/
    tokens.css     every colour, size, duration. Nothing else holds a raw value
    base.css       reset, document typography, a11y primitives
    primitives.css containers, the meridian, buttons, labels, status pips, plates
  components/    one concern each, styles scoped alongside
  layouts/Base.astro   head, SEO, JSON-LD, masthead, meridian, footer
  pages/         routes
tests/           vitest — status logic, date handling, data integrity
scripts/         dev tooling (screenshots, OG card). Not part of the build.
```

### Routes

| Route              | State                                                     |
| ------------------ | --------------------------------------------------------- |
| `/`                | Full homepage — 11 movements                               |
| `/events`          | Next event + the full record                               |
| `/events/[slug]`   | 11 pages, one per event                                    |
| `/cities`          | The survey plate + gazetteer                               |
| `/cities/[slug]`   | 14 pages; active and open cities get different treatments  |
| `/builders`        | The roster + the photographic record                       |
| `/builders/[slug]` | Profile, honest about what the entry is missing            |
| `/projects`        | The archive's open call                                    |
| `/stories`         | The photographic record                                    |
| `/community`       | Ways in, FAQ, partners, affiliation                        |
| `/404`             | —                                                          |

35 pages build from 11 route files.

## The design system

Read `src/styles/tokens.css` first — it is the whole system, and the only file with raw values.

**Ground.** Warm paper (`--paper`) with ink type. Sections that flip dark add `.on-night`, which
remaps the semantic tokens rather than overriding colours one by one, so everything inside keeps
working unchanged.

**Colour discipline.** Clay (`--clay`, Claude's orange) is reserved for three things: live/next
state, the meridian, and the mark. It is never decoration. There is a hard contrast rule enforced
in review and written into the token file:

- `--clay` on paper is 2.7:1 — **fill only, never text**
- `--clay-deep` on paper is 5.3:1 — safe for text
- `--clay` on night is 5.9:1 — safe for text

**Type.** Fraunces (display, `WONK 1` — the axis that gives it a voice), Inter (body), IBM Plex
Mono (all metadata, labels and coordinates). The scale is deliberately gapped rather than modular:
editorial pages need violent contrast between a poster headline and a data label.

**Shape.** Hairlines and right angles. Nothing on this site is a pill; the largest radius in the
system is 3px.

### The meridian

The one recurring device. A single clay thread runs the left rail of every page and does six jobs
at once: the map's meridian, the timeline's spine, the archive's index (it ticks at each section),
the scroll indicator (it draws as you travel), the grid the content column aligns to, and — in the
footer — the record's full stop, where it terminates in the station mark.

It disappears below 64em, where the rail would crowd the text.

### The map

`src/lib/geo.ts` and `components/IndiaPlate.astro`.

The map is **a coordinate plot, not a traced outline**. Cities sit at their true latitude and
longitude on a graticule, the way a survey sheet does it. This was a deliberate choice for three
reasons: every dot is honest; it sidesteps depicting national boundaries, which is a regulated
matter in India and not something a community site should get wrong; and it looks like a
cartographic artifact rather than a Google Maps clone.

Two variants from one component — `ghost` (the hero's quiet backdrop) and `plate` (the full
instrument, with a readout panel that updates on hover *and* focus, and works by keyboard).

## Content honesty

This is the part to not quietly undo.

| Area                   | State                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- |
| Events                 | 11 real events, real Luma links, real venues                                       |
| Cities                 | 1 active (Bhopal), 13 plotted and explicitly marked "no chapter yet"               |
| Builders               | 2 — the workshop leads the community publicly credited. No invented bios or links. |
| Projects               | **Empty.** No verified submissions exist yet.                                      |
| Stories                | **Empty.** Runs on the photographic record instead.                                |
| Member / prototype counts | Chapter-reported, labelled as such, with the source rendered on the page.       |

`tests/data.test.ts` enforces this: a city cannot be `active` without a real event, cannot report
figures without naming a source, and an `open` city cannot claim an organiser.

The empty archives are designed, not broken. `/projects` renders a *specimen entry* — the shape of
a submission with its fields labelled — and the builder roster ends on an open row. Add one real
project to `src/data/projects.ts` and the grid takes over automatically.

### Relationship to Anthropic

This is an independent, non-commercial, volunteer-run community. It is **not** an Anthropic
property, programme or endorsement. That line lives in `site.affiliation` and renders in the
footer, the FAQ and the JSON-LD. Do not soften it without checking with the organisers.

## Adding to the record

**A new event** — add one entry to `src/data/events.ts`. Do not touch anything else: the hero, the
masthead chip, the meta description, the JSON-LD, the index and every status badge all derive from
it. There is no "featured" flag to move and no date to update in a second place.

**A new chapter** — add the city to `src/data/cities.ts` with `status: 'active'`, a real organiser,
and at least one event. The tests will fail if any of those are missing.

**A project or a builder** — fill in the array. The UI switches from its open-call state on its own.

## Accessibility

Semantic landmarks and a logical heading order; a skip link; visible 2px focus rings that are never
styled away; every map node reachable by keyboard with the readout responding to focus as well as
hover; no hover-only interaction anywhere; `prefers-reduced-motion` honoured throughout (the reveal
system only displaces content once JS confirms motion is wanted, so with it off the page is simply
finished); touch targets at 44px; AA contrast, with the clay rule above enforcing the one place it
would otherwise slip.

## Deploying

Netlify (`netlify.toml`) and Vercel (`vercel.json`) are both configured: build `npm run build`,
publish `dist`. Nothing server-side.

Set `site` in `astro.config.mjs` if the domain changes — canonical URLs, Open Graph tags and the
sitemap all read from it.

Regenerate the share card after a brand change: `node scripts/og.mjs`.

## Dev tooling

`scripts/shoot.mjs` and `scripts/shoot-pages.mjs` screenshot the site across the breakpoints the
design targets (375 / 430 / 768 / 1280 / 1440 / 1728) using Playwright, for visual review.
`scripts/slice.py` cuts a tall full-page capture into readable bands. Neither is part of the build.

## Credits

The Bhopal chapter is organised by [The Origin Guild](https://t.me/tog_guild). Event photography
and the event record come from that chapter. City photography carries its original Wikimedia
Commons and Unsplash attribution — see `src/assets/city/` and the source project.
