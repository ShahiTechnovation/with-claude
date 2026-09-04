import { describe, expect, it } from 'vitest';
import { cities } from '../src/data/cities';
import { isCityIndexable, nonIndexablePaths } from '../src/lib/indexable';

/**
 * The record, and what gets to be a search result.
 *
 * The timeline is exercised against the live data on purpose — unlike the
 * search matcher, its whole job is to describe the real record, and the
 * properties asserted here hold for any record rather than for a fixture.
 */
describe('the timeline', () => {
  it('reads forward in time', async () => {
    const { timeline } = await import('../src/data');
    const months = timeline();
    const keys = months.map((month) => month.key);
    expect([...keys].sort()).toEqual(keys);
  });

  it('labels a year exactly once, at the month that opens it', async () => {
    const { timeline } = await import('../src/data');
    const months = timeline();
    const opened = months.filter((month) => month.opensYear).map((month) => month.year);
    expect(new Set(opened).size).toBe(opened.length);
  });

  it('never invents an entry — everything carries a real date', async () => {
    const { timeline } = await import('../src/data');
    for (const month of timeline()) {
      expect(month.entries.length).toBeGreaterThan(0);
      for (const entry of month.entries) {
        expect(entry.date, entry.subject).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(entry.date.startsWith(month.key), entry.subject).toBe(true);
      }
    }
  });

  it('holds every dated thing the activity feed knows about', async () => {
    const { communitySignal, timeline } = await import('../src/data');
    const onRail = new Set(
      timeline().flatMap((month) => month.entries.map((entry) => `${entry.date}:${entry.subject}`)),
    );
    for (const item of communitySignal(50)) {
      expect(onRail, item.subject).toContain(`${item.date}:${item.subject}`);
    }
  });
});

describe('indexability', () => {
  it('a city with nothing in it is not a search result', () => {
    for (const city of cities) {
      if (!isCityIndexable(city)) {
        expect(nonIndexablePaths(), city.slug).toContain(`/cities/${city.slug}`);
      }
    }
  });

  it('one real record is enough to make a city indexable', async () => {
    const { citySignal } = await import('../src/data');
    for (const city of cities) {
      const signal = citySignal(city);
      const hasSomething =
        signal.eventCount + signal.builderCount + signal.projectCount + signal.storyCount > 0 ||
        signal.ambassadors.length > 0;
      expect(isCityIndexable(city), city.slug).toBe(hasSomething);
    }
  });

  it('excludes nothing that is not a city', () => {
    for (const path of nonIndexablePaths()) {
      expect(path.startsWith('/cities/')).toBe(true);
    }
  });
});
