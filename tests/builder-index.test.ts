/**
 * The builders index counts events the way the builder's profile does. It
 * once left out the rooms an Ambassador hosted, so the index read 01 where
 * the profile read 17.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the builders index', () => {
  it('counts Ambassador-hosted rooms, as the profile page does', () => {
    const index = readFileSync('src/components/BuilderIndex.astro', 'utf8');
    const profile = readFileSync('src/pages/builders/[slug].astro', 'utf8');
    const count = /eventCount: ([\s\S]*?),\n\s*projectCount/.exec(index)?.[1] ?? '';
    expect(count).toContain('data.eventsOf(builder)');
    expect(count).toContain('data.eventsHostedBy(ambassador.slug)');
    expect(profile).toContain('new Set([...events, ...hosted])');
  });

  it('prints each count unpadded, and only when it is above zero', () => {
    const index = readFileSync('src/components/BuilderIndex.astro', 'utf8');
    expect(index).not.toMatch(/padStart\(2, '0'\)\} (events|projects)/);
    expect(index).toContain("entry.eventCount > 0 && <span>{plural(entry.eventCount, 'event')}");
    expect(index).toContain(
      "entry.projectCount > 0 && <span>{plural(entry.projectCount, 'project')}",
    );
  });

  it('the profile lists its events with the shared rows, not a copy of them', () => {
    const profile = readFileSync('src/pages/builders/[slug].astro', 'utf8');
    expect(profile).toContain('<EventRecord events={allEvents} />');
    expect(profile).not.toContain('row-plate');
  });
});
