import { describe, expect, it } from 'vitest';
import { builders } from '../src/data/builders';
import { cities } from '../src/data/cities';
import { events } from '../src/data/events';
import { projects } from '../src/data/projects';
import { EXTENT, formatCoords, project } from '../src/lib/geo';

/**
 * Guardrails on the record itself. These catch the two failure modes that
 * would actually hurt: broken cross-references (a speaker or city that does
 * not exist) and honesty drift (a claim without a source).
 */
const citySlugs = new Set(cities.map((c) => c.slug));
const builderSlugs = new Set(builders.map((b) => b.slug));
const eventSlugs = new Set(events.map((e) => e.slug));

describe('referential integrity', () => {
  it('every event points at a real city', () => {
    for (const event of events) {
      expect(citySlugs, `event ${event.slug}`).toContain(event.citySlug);
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

  it('every project points at a real city and real builders', () => {
    for (const proj of projects) {
      expect(citySlugs, `project ${proj.slug}`).toContain(proj.citySlug);
      for (const slug of proj.builderSlugs) {
        expect(builderSlugs, `project ${proj.slug}`).toContain(slug);
      }
    }
  });

  it('slugs are unique', () => {
    expect(eventSlugs.size).toBe(events.length);
    expect(citySlugs.size).toBe(cities.length);
    expect(builderSlugs.size).toBe(builders.length);
  });
});

describe('honesty rules', () => {
  it('only active cities report figures, and every figure names its source', () => {
    for (const city of cities) {
      if (city.reported) {
        expect(city.status, `${city.slug} reports figures`).toBe('active');
        expect(city.reported.source.length).toBeGreaterThan(10);
      }
    }
  });

  it('a city is only active if it has actually run an event', () => {
    for (const city of cities.filter((c) => c.status === 'active')) {
      const held = events.filter((e) => e.citySlug === city.slug);
      expect(held.length, `${city.slug} is marked active`).toBeGreaterThan(0);
    }
  });

  it('open cities claim no organiser and no numbers', () => {
    for (const city of cities.filter((c) => c.status === 'open')) {
      expect(city.reported, `${city.slug}`).toBeUndefined();
      expect(city.organiser, `${city.slug}`).toBeUndefined();
      expect(events.some((e) => e.citySlug === city.slug)).toBe(false);
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
