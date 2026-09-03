import { describe, expect, it } from 'vitest';
import { ambassadors } from '../src/data/ambassadors';
import { builders } from '../src/data/builders';
import { cities } from '../src/data/cities';
import { events } from '../src/data/events';
import { projects } from '../src/data/projects';
import { stories } from '../src/data/stories';
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

const everyRecord = [
  ...cities.map((r) => ['city', r] as const),
  ...events.map((r) => ['event', r] as const),
  ...builders.map((r) => ['builder', r] as const),
  ...projects.map((r) => ['project', r] as const),
  ...stories.map((r) => ['story', r] as const),
  ...ambassadors.map((r) => ['ambassador', r] as const),
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
