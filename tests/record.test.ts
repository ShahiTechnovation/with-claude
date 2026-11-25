import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cities } from '../src/data/cities';
import { isCityIndexable, isPrivatePath, nonIndexablePaths } from '../src/lib/indexable';

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

  it('keeps same-day projects in the record’s order', async () => {
    // The newest-first sort answered -1 for two entries of the same day, which reversed them: the
    // Build Day's projects read from the record's last card to its first.
    const { publicProjects, timeline } = await import('../src/data');
    const rank = new Map(publicProjects.map((p, i) => [`/projects/${p.slug}/`, i]));
    const byDay = new Map<string, number[]>();
    for (const entry of timeline().flatMap((month) => month.entries)) {
      if (entry.kind !== 'project-published') continue;
      byDay.set(entry.date, [...(byDay.get(entry.date) ?? []), rank.get(entry.href ?? '') ?? -1]);
    }
    const shared = [...byDay.values()].filter((ranks) => ranks.length > 1);
    expect(shared.length, 'days with more than one project').toBeGreaterThan(0);
    for (const ranks of shared) expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('puts two events of one day in time order, then that day’s projects in record order', async () => {
    const { RecordSelectors } = await import('../src/data/selectors');
    const { tsRecordSet } = await import('../src/data/source-ts');
    const rs = tsRecordSet();
    const day = '2026-11-22' as const;
    const event = { ...rs.events[0]!, date: day, statusOverride: undefined };
    const project = { ...rs.projects[0]!, status: 'published' as const, createdAt: day };
    const selectors = new RecordSelectors({
      ...rs,
      // The later event comes first in the input: the start time decides, not the input order.
      events: [
        { ...event, id: 'evt-late', slug: 'late', startTime: '14:00', endTime: '15:00' },
        { ...event, id: 'evt-early', slug: 'early', startTime: '09:00', endTime: '10:00' },
      ],
      // The record's order, which A–Z would reverse.
      projects: [
        { ...project, id: 'prj-zulu', slug: 'zulu', title: 'Zulu' },
        { ...project, id: 'prj-alpha', slug: 'alpha', title: 'Alpha' },
      ],
      builders: [],
      stories: [],
      useCases: [],
      guides: [],
    });
    const hrefs = selectors
      .timeline(new Date('2026-11-23T12:00:00+05:30'))
      .flatMap((month) => month.entries)
      .filter((entry) => entry.date === day)
      .map((entry) => entry.href);
    expect(hrefs).toEqual([
      '/events/early/',
      '/events/late/',
      '/projects/zulu/',
      '/projects/alpha/',
    ]);
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

describe('the timeline component', () => {
  const source = readFileSync('src/components/Timeline.astro', 'utf8');

  it('heads each month with a serif h2 and keeps the filled and open marks', () => {
    expect(source).toContain('<h2 class="t-h3 month-name"');
    expect(source).toContain("{ 'is-ahead': entry.ahead }");
    expect(source).toContain('.entry.is-ahead .entry-mark');
  });

  it('sets no mono, tracked or uppercase type', () => {
    expect(source).not.toMatch(/font-mono|text-transform:\s*uppercase|track-meta|t-micro/);
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

  /**
   * THE SITEMAP AND `noindex` HAVE TO AGREE.
   *
   * All six `/me/*` pages set `noindex` and `Cache-Control: private, no-store`
   * — and were listed in `sitemap-0.xml` regardless, because the only
   * exclusion rule was about cities. The site was telling crawlers both
   * "never index this" and "here, index this" about the same URL.
   *
   * Asserted on the PREFIX rather than on the six known paths, because the
   * six were not forgotten through carelessness: nothing connected adding an
   * account page to updating a sitemap rule. A test listing six paths would
   * pass while the seventh page leaked.
   */
  it('keeps the account area and the API out of the sitemap', () => {
    for (const path of [
      '/me/',
      '/me/profile/',
      '/me/profile/edit/',
      '/me/projects/',
      '/me/projects/new/',
      '/me/settings/',
      '/me/some/page/nobody/has/written/yet/',
      '/api/health/',
    ]) {
      expect(isPrivatePath(path), path).toBe(true);
    }
  });

  it('does not treat a public route as private', () => {
    for (const path of [
      '/',
      '/builders/',
      '/projects/',
      '/events/',
      '/cities/bhopal/',
      '/record/',
    ]) {
      expect(isPrivatePath(path), path).toBe(false);
    }
  });
});
