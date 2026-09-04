import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cityName, creditsFor, participationPaths, venueLabel } from '../src/data';
import { forms, formById } from '../src/data/forms';
import { listJoin } from '../src/lib/words';
import { ambassadors } from '../src/data/ambassadors';
import { builders } from '../src/data/builders';
import { cities } from '../src/data/cities';
import { events } from '../src/data/events';
import { guides } from '../src/data/guides';
import { projects } from '../src/data/projects';
import { stories } from '../src/data/stories';
import { useCases } from '../src/data/use-cases';
import { cityState } from '../src/lib/city';
import { EXTENT, formatCoords, project } from '../src/lib/geo';

/**
 * Guardrails on the record itself.
 *
 * These catch the failure modes that would actually do damage: broken
 * cross-references, and governance drift — a city that looks like a chapter, a
 * person who looks appointed, or a number without a source.
 */
const citySlugs = new Set(cities.map((c) => c.slug));
const builderSlugs = new Set(builders.map((b) => b.slug));
const eventSlugs = new Set(events.map((e) => e.slug));
const ambassadorSlugs = new Set(ambassadors.map((a) => a.slug));

const projectSlugs = new Set(projects.map((p) => p.slug));
const useCaseSlugs = new Set(useCases.map((u) => u.slug));

const everyRecord = [
  ...cities.map((r) => ['city', r] as const),
  ...events.map((r) => ['event', r] as const),
  ...builders.map((r) => ['builder', r] as const),
  ...projects.map((r) => ['project', r] as const),
  ...stories.map((r) => ['story', r] as const),
  ...ambassadors.map((r) => ['ambassador', r] as const),
  ...useCases.map((r) => ['use case', r] as const),
  ...guides.map((r) => ['guide', r] as const),
];

/** Everything the community writes, which all carries the same byline rule. */
const everyByline = [
  ...useCases.map((r) => ['use case', r] as const),
  ...guides.map((r) => ['guide', r] as const),
];

describe('referential integrity', () => {
  it('every event points at a real city', () => {
    for (const event of events) {
      expect(citySlugs, `event ${event.slug}`).toContain(event.citySlug);
    }
  });

  it('every event host points at a real ambassador', () => {
    for (const event of events) {
      if (event.host.ambassadorSlug) {
        expect(ambassadorSlugs, `event ${event.slug}`).toContain(event.host.ambassadorSlug);
      }
    }
  });

  it('every co-host credit points at a real builder', () => {
    for (const event of events) {
      for (const slug of event.host.builderSlugs ?? []) {
        expect(builderSlugs, `event ${event.slug}`).toContain(slug);
      }
    }
  });

  it('every speaker credit points at a real builder', () => {
    for (const event of events) {
      for (const slug of event.speakerSlugs ?? []) {
        expect(builderSlugs, `event ${event.slug}`).toContain(slug);
      }
    }
  });

  it('every builder points at a real city and real events', () => {
    for (const builder of builders) {
      expect(citySlugs, `builder ${builder.slug}`).toContain(builder.citySlug);
      for (const slug of builder.eventSlugs ?? []) {
        expect(eventSlugs, `builder ${builder.slug}`).toContain(slug);
      }
    }
  });

  it('every project points at a real city, builders and event', () => {
    for (const proj of projects) {
      expect(citySlugs, `project ${proj.slug}`).toContain(proj.citySlug);
      for (const slug of proj.builderSlugs) {
        expect(builderSlugs, `project ${proj.slug}`).toContain(slug);
      }
      if (proj.builtAtEventSlug) {
        expect(eventSlugs, `project ${proj.slug}`).toContain(proj.builtAtEventSlug);
      }
    }
  });

  it('every ambassador points at a real city and, if claimed, a real builder', () => {
    for (const ambassador of ambassadors) {
      expect(citySlugs, `ambassador ${ambassador.slug}`).toContain(ambassador.citySlug);
      if (ambassador.builderSlug) {
        expect(builderSlugs, `ambassador ${ambassador.slug}`).toContain(ambassador.builderSlug);
      }
    }
  });

  it('slugs are unique within each collection', () => {
    expect(eventSlugs.size).toBe(events.length);
    expect(citySlugs.size).toBe(cities.length);
    expect(builderSlugs.size).toBe(builders.length);
    expect(ambassadorSlugs.size).toBe(ambassadors.length);
  });
});

describe('record shape', () => {
  it('every record carries an id, a slug and a moderation status', () => {
    for (const [kind, record] of everyRecord) {
      expect(record.id, `${kind}`).toBeTruthy();
      expect(record.slug, `${kind} ${record.id}`).toBeTruthy();
      expect(['pending', 'published', 'featured', 'archived'], `${kind} ${record.slug}`).toContain(
        record.status,
      );
    }
  });

  it('never guesses a timestamp', () => {
    // An invented `createdAt` would surface in the activity feed as invented
    // activity. Unknown dates are omitted, not filled in.
    for (const [kind, record] of everyRecord) {
      if (record.createdAt) {
        expect(record.createdAt, `${kind} ${record.slug}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
});

describe('governance', () => {
  it('every ambassador says how the status was verified', () => {
    for (const ambassador of ambassadors) {
      expect(ambassador.verifiedVia.length, `ambassador ${ambassador.slug}`).toBeGreaterThan(10);
      expect(ambassador.title).toBe('Claude Community Ambassador');
    }
  });

  it('a city can only reach ambassador-led through a real ambassador', () => {
    for (const city of cities) {
      const hasAmbassador = ambassadors.some((a) => a.citySlug === city.slug);
      const state = cityState({
        hasAmbassador,
        eventCount: events.filter((e) => e.citySlug === city.slug).length,
        interestCount: city.interest?.count ?? 0,
      });
      if (state === 'ambassador-led') {
        expect(hasAmbassador, `${city.slug} derived ambassador-led`).toBe(true);
      }
    }
  });

  it('a city with nothing verified derives to discovery, not to an invitation', () => {
    for (const city of cities) {
      const hasAmbassador = ambassadors.some((a) => a.citySlug === city.slug);
      const eventCount = events.filter((e) => e.citySlug === city.slug).length;
      const interestCount = city.interest?.count ?? 0;
      if (!hasAmbassador && eventCount === 0 && interestCount === 0) {
        expect(cityState({ hasAmbassador, eventCount, interestCount }), city.slug).toBe(
          'discovery',
        );
      }
    }
  });

  it('only cities with activity report figures, and every figure names its source', () => {
    for (const city of cities) {
      if (city.reported) {
        const eventCount = events.filter((e) => e.citySlug === city.slug).length;
        expect(eventCount, `${city.slug} reports figures`).toBeGreaterThan(0);
        expect(city.reported.source.length, `${city.slug}`).toBeGreaterThan(10);
      }
    }
  });

  it('a city with no events claims no organiser and no numbers', () => {
    for (const city of cities) {
      const eventCount = events.filter((e) => e.citySlug === city.slug).length;
      if (eventCount === 0) {
        expect(city.reported, `${city.slug}`).toBeUndefined();
        expect(city.organiser, `${city.slug}`).toBeUndefined();
      }
    }
  });

  it('a city interest count always names its source', () => {
    for (const city of cities) {
      if (city.interest) {
        expect(city.interest.source.length, `${city.slug}`).toBeGreaterThan(10);
        expect(city.interest.count).toBeGreaterThan(0);
      }
    }
  });
});

describe('authorship', () => {
  it('everything written carries an author with a credential', () => {
    // An unattributed workflow is indistinguishable from a generated one,
    // which is the exact thing the knowledge library exists not to be.
    for (const [kind, record] of everyByline) {
      const author = record.author;
      expect(Boolean(author.builderSlug || author.name), `${kind} ${record.slug}`).toBe(true);
      expect(author.credential.length, `${kind} ${record.slug}`).toBeGreaterThan(10);
    }
  });

  it('every byline that names a builder points at a real one', () => {
    for (const [kind, record] of everyByline) {
      if (record.author.builderSlug) {
        expect(builderSlugs, `${kind} ${record.slug}`).toContain(record.author.builderSlug);
      }
    }
  });

  it('every source cited is labelled', () => {
    for (const [kind, record] of everyByline) {
      for (const source of record.sources ?? []) {
        expect(source.label.length, `${kind} ${record.slug}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('use case shape', () => {
  it('names what Claude did AND what the person did', () => {
    // A record that cannot name the human contribution is a product demo.
    for (const useCase of useCases) {
      expect(useCase.claudeDid.length, `use case ${useCase.slug}`).toBeGreaterThan(0);
      expect(useCase.humanDid.length, `use case ${useCase.slug}`).toBeGreaterThan(0);
    }
  });

  it('every workflow step says who did it', () => {
    for (const useCase of useCases) {
      expect(useCase.workflow.length, `use case ${useCase.slug}`).toBeGreaterThan(0);
      for (const step of useCase.workflow) {
        expect(['human', 'claude', 'both'], `use case ${useCase.slug}`).toContain(step.by);
      }
    }
  });

  it('every cross-reference resolves', () => {
    for (const useCase of useCases) {
      if (useCase.citySlug) expect(citySlugs, useCase.slug).toContain(useCase.citySlug);
      if (useCase.eventSlug) expect(eventSlugs, useCase.slug).toContain(useCase.eventSlug);
      if (useCase.projectSlug) expect(projectSlugs, useCase.slug).toContain(useCase.projectSlug);
    }
  });
});

describe('guide shape', () => {
  it('a modified guide was modified after it was published', () => {
    for (const guide of guides) {
      if (guide.modified) {
        expect(guide.modified >= guide.published, `guide ${guide.slug}`).toBe(true);
      }
    }
  });

  it('every cross-reference resolves', () => {
    for (const guide of guides) {
      for (const slug of guide.builderSlugs ?? []) expect(builderSlugs, guide.slug).toContain(slug);
      for (const slug of guide.eventSlugs ?? []) expect(eventSlugs, guide.slug).toContain(slug);
      for (const slug of guide.projectSlugs ?? []) expect(projectSlugs, guide.slug).toContain(slug);
      for (const slug of guide.useCaseSlugs ?? []) expect(useCaseSlugs, guide.slug).toContain(slug);
    }
  });
});

describe('event data shape', () => {
  it('uses ISO dates and 24-hour times', () => {
    for (const event of events) {
      expect(event.date, event.slug).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(event.startTime, event.slug).toMatch(/^\d{2}:\d{2}$/);
      if (event.endTime) expect(event.endTime, event.slug).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('never ends before it starts', () => {
    for (const event of events) {
      if (event.endTime) expect(event.endTime > event.startTime, event.slug).toBe(true);
    }
  });

  it('sends registration links somewhere real', () => {
    for (const event of events) {
      if (event.registrationUrl) expect(event.registrationUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('geo', () => {
  it('plots every city inside the plate extent', () => {
    for (const city of cities) {
      expect(city.lat, city.slug).toBeGreaterThan(EXTENT.minLat);
      expect(city.lat, city.slug).toBeLessThan(EXTENT.maxLat);
      expect(city.lon, city.slug).toBeGreaterThan(EXTENT.minLon);
      expect(city.lon, city.slug).toBeLessThan(EXTENT.maxLon);
    }
  });

  it('puts north above south and east right of west', () => {
    const delhi = project(28.61, 77.21);
    const chennai = project(13.08, 80.27);
    const mumbai = project(19.08, 72.88);
    const kolkata = project(22.57, 88.36);

    expect(delhi.y).toBeLessThan(chennai.y);
    expect(mumbai.x).toBeLessThan(kolkata.x);
  });

  it('formats coordinates with a hemisphere', () => {
    expect(formatCoords(23.2599, 77.4126)).toBe('23.26° N, 77.41° E');
  });
});

// =========================================================================
// IMPACT LAB PROJECT ARCHIVE — regression tests
// =========================================================================

describe('Impact Lab project archive', () => {
  const impactLabProjects = projects.filter(
    (p) => p.builtAtEventSlug === 'claude-code-impact-lab',
  );

  it('publishes exactly 26 unique projects', () => {
    expect(impactLabProjects).toHaveLength(26);
    const slugs = new Set(impactLabProjects.map((p) => p.slug));
    expect(slugs.size).toBe(26);
  });

  it('every project points at Bhopal', () => {
    for (const project of impactLabProjects) {
      expect(project.citySlug, project.slug).toBe('bhopal');
    }
  });

  it('every project points at the Impact Lab event', () => {
    for (const project of impactLabProjects) {
      expect(project.builtAtEventSlug, project.slug).toBe('claude-code-impact-lab');
    }
  });

  it('every project has at least one builder slug', () => {
    for (const project of impactLabProjects) {
      expect(project.builderSlugs.length, project.slug).toBeGreaterThan(0);
    }
  });

  it('every builder slug resolves to a builder in the registry', () => {
    for (const project of impactLabProjects) {
      for (const slug of project.builderSlugs) {
        expect(builderSlugs, `project ${project.slug} → ${slug}`).toContain(slug);
      }
    }
  });

  it('contains exactly 69 builder-name mentions across all projects', () => {
    const totalMentions = impactLabProjects.reduce(
      (sum, p) => sum + p.builderSlugs.length,
      0,
    );
    expect(totalMentions).toBe(69);
  });

  it('does not include excluded projects', () => {
    const titles = impactLabProjects.map((p) => p.title.toLowerCase());
    expect(titles).not.toContain('bhopal lake guardian ai');
    expect(titles).not.toContain('hospital management system');
  });

  it('collapsed duplicate submission names to single entries', () => {
    const count = (name: string) =>
      impactLabProjects.filter((p) => p.title.toLowerCase() === name.toLowerCase()).length;
    expect(count('Carbon Miles'), 'Carbon Miles').toBe(1);
    expect(count('Bhopal Metro Website'), 'Bhopal Metro Website').toBe(1);
    expect(count('Bhopal Tourism'), 'Bhopal Tourism').toBe(1);
  });

  it('every repoUrl is a GitHub URL', () => {
    for (const project of impactLabProjects) {
      if (project.repoUrl) {
        expect(project.repoUrl, project.slug).toMatch(/^https:\/\/github\.com\//);
      }
    }
  });

  it('every live url is HTTPS and not a Drive link or bare word', () => {
    for (const project of impactLabProjects) {
      if (project.url) {
        expect(project.url, project.slug).toMatch(/^https:\/\//);
        expect(project.url, project.slug).not.toMatch(/drive\.google\.com/);
        expect(project.url, project.slug).not.toBe('Live');
        expect(project.url, project.slug).not.toBe('Yes');
        expect(project.url, project.slug).not.toBe('None');
      }
    }
  });

  it('no project field contains an email address', () => {
    for (const project of impactLabProjects) {
      const fields = [
        project.title,
        project.summary,
        project.description,
        project.url,
        project.repoUrl,
      ].filter(Boolean);
      for (const field of fields) {
        expect(field, `${project.slug}: ${field}`).not.toMatch(
          /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
        );
      }
    }
  });

  it('no project carries a videoUrl (Demo Video is suppressed)', () => {
    for (const project of impactLabProjects) {
      expect(project.videoUrl, project.slug).toBeUndefined();
    }
  });

  it('Impact Lab builders are pending (no automatic public profiles)', () => {
    const impactLabBuilderSlugs = new Set(
      impactLabProjects.flatMap((p) => p.builderSlugs),
    );
    for (const builder of builders) {
      if (impactLabBuilderSlugs.has(builder.slug) && builder.slug !== 'aniket-sahu' && builder.slug !== 'vishal-kumar') {
        expect(builder.status, builder.slug).toBe('pending');
      }
    }
  });

  it('Impact Lab event carries all 26 project slugs', () => {
    const impactLab = events.find((e) => e.slug === 'claude-code-impact-lab');
    expect(impactLab).toBeDefined();
    expect(impactLab!.projectSlugs).toBeDefined();
    expect(impactLab!.projectSlugs).toHaveLength(26);
  });
});

// =========================================================================
// PARTICIPATION PATHS — the `formId` mismatch that went unnoticed
// =========================================================================

/**
 * Two participation paths named submission forms that do not exist
 * (`project`, `builder`, against real ids `contribute` / `build` /
 * `practice` / `city`). Nothing read the field, so nothing failed.
 *
 * `Participation.astro` now derives each CTA's destination from the named
 * form, which makes a bad id a build error. These are the cheaper guard.
 */
describe('participation paths', () => {
  it('every submission path names a real form', () => {
    for (const path of participationPaths) {
      if (path.kind !== 'submission') continue;
      expect(path.formId, `path ${path.id}`).toBeDefined();
      expect([...formById.keys()], `path ${path.id}`).toContain(path.formId!);
    }
  });

  it('a submission path carries no second, hand-written destination', () => {
    // The type says `url` is "undefined only for `submission` paths" — the
    // anchor is read off the form, so a hand-written one could only drift.
    for (const path of participationPaths) {
      if (path.kind === 'submission') expect(path.url, `path ${path.id}`).toBeUndefined();
    }
  });

  it('every non-submission path has somewhere real to go', () => {
    for (const path of participationPaths) {
      if (path.kind === 'submission' || path.kind === 'official') continue;
      expect(path.url, `path ${path.id}`).toBeTruthy();
    }
  });

  it('every form is reachable from /join by its own anchor', () => {
    for (const form of forms) {
      expect(form.anchor, `form ${form.id}`).toBeTruthy();
    }
    // Anchors are unique, or two panels would fight over the same fragment.
    const anchors = forms.map((f) => f.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});

// =========================================================================
// ONE AUTHORITATIVE EVENT DATASET
// =========================================================================

/**
 * `/events/claude-community` carried its own inline copy of the event list,
 * which had drifted: a workshop was listed at 02:30 in the morning, several
 * venues had gone missing, and the counts were typed in by hand. It now reads
 * the same selectors as everything else.
 */
describe('the event record has one source', () => {
  it('has no second event dataset in the page that used to hold one', () => {
    const page = readFileSync('src/pages/events/claude-community.astro', 'utf8');

    expect(page).not.toMatch(/Event Dataset Hardcoded/);
    // The two shapes the inline copy used, neither of which is in the record.
    expect(page).not.toMatch(/dateShort:\s*'[A-Z]{3} \d\d'/);
    expect(page).not.toMatch(/luma:\s*'https:/);
    // And it reads the selector layer instead.
    expect(page).toMatch(/from '@\/data'/);
    expect(page).toMatch(/upcomingEvents\(\)/);
    expect(page).toMatch(/pastEvents\(\)/);
  });

  it('hard-codes no count that the record already knows', () => {
    const page = readFileSync('src/pages/events/claude-community.astro', 'utf8');
    // `14 events`, `<dd>03</dd>`, `<span class="coords">11</span>` and the
    // like — every one of them a number that goes stale on the next event.
    expect(page).not.toMatch(/stamp="\d+ events"/);
    expect(page).not.toMatch(/<dd[^>]*>\d\d?<\/dd>/);
    expect(page).not.toMatch(/class="coords">\d/);
  });

  it('renders a venue the same way everywhere', () => {
    // One rule, in the selector layer, rather than a copy per component.
    const record = readFileSync('src/components/EventRecord.astro', 'utf8');
    const history = readFileSync('src/pages/events/claude-community.astro', 'utf8');
    expect(record).toMatch(/venueLabel/);
    expect(history).toMatch(/venueLabel/);
  });

  it('omits a venue that is private or is only the city name', () => {
    for (const event of events) {
      const label = venueLabel(event);
      if (event.venue.private) {
        expect(label, `event ${event.slug}`).toBeUndefined();
      } else if (event.venue.name === cityName(event.citySlug)) {
        expect(label, `event ${event.slug}`).toBeUndefined();
      } else {
        expect(label, `event ${event.slug}`).toBeTruthy();
      }
    }
  });

  it('credits a room from the record rather than from a typed-out string', () => {
    const impactLab = events.find((e) => e.slug === 'claude-code-impact-lab')!;
    // Ambassador first, then co-hosts, then the organisations that lent the room.
    expect(creditsFor(impactLab)).toEqual([
      'Aniket Sahu',
      'The Origin Guild',
      'Builder Base',
    ]);
    expect(listJoin(creditsFor(impactLab))).toBe('Aniket Sahu, The Origin Guild & Builder Base');
  });
});

describe('listJoin', () => {
  it.each([
    [[], ''],
    [['A'], 'A'],
    [['A', 'B'], 'A & B'],
    [['A', 'B', 'C'], 'A, B & C'],
    [['A', 'B', 'C', 'D'], 'A, B, C & D'],
  ])('joins %j as %j', (input, expected) => {
    expect(listJoin(input as string[])).toBe(expected);
  });
});
