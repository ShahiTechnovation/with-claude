/**
 * The builders index counts events the way the builder's profile does. It
 * once left out the rooms an Ambassador hosted, so the index read 01 where
 * the profile read 17. Since batch 006 it also pins the shared `initials()`
 * helper, the profile's initials portrait and the index card's 56×56
 * portrait box.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { initials } from '../src/lib/words';

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

  it('draws initials from one helper, on the index card and on a profile with no photo', () => {
    expect(initials('Aniket Sahu')).toBe('AS');
    expect(initials('Punit')).toBe('P');
    expect(initials('  vishal  kumar singh ')).toBe('VK');
    expect(initials('')).toBe('');
    const profile = readFileSync('src/pages/builders/[slug].astro', 'utf8');
    expect(profile).toMatch(
      /\) : \(\s*<span\s+class:list=\{\['portrait', 'initials', \{ 'is-verified': ambassador \}\]\}\s+aria-hidden="true"\s*>\s*\{initials\(builderRow\.name\)\}/,
    );
    for (const file of [
      'src/components/BuilderIndex.astro',
      'src/components/home/MadeWith.astro',
      'src/components/EventFeature.astro',
    ]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\.map\(\((w|part)\) => (w|part)\[0\]/);
    }
  });

  it('reserves the box of an uploaded portrait on the index card', () => {
    const index = readFileSync('src/components/BuilderIndex.astro', 'utf8');
    expect(index).toMatch(/src=\{entry\.remotePortrait\}\s+alt=""\s+width="56"\s+height="56"/);
  });
});
