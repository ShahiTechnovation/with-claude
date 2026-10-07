/**
 * THE PROJECT CARD'S PARTS: the icon tiles, the one line of text, the props a card is built from,
 * and the plate that stands for an event.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projects } from '../src/data/projects';
import { asset } from '../src/lib/images';
import { eventPlate } from '../src/lib/event-plate';
import { cardProps, cardText } from '../src/lib/project-display';
import { projectIcon } from '../src/lib/project-icon';
import { lint } from '../scripts/icons/lint.mjs';

const ICONS = join(process.cwd(), 'src/assets/project-icons');
const files = readdirSync(ICONS).filter((f) => f.endsWith('.svg'));

describe('project icons', () => {
  it('every project in the record has an icon, and every icon has a project', () => {
    const slugs = projects.map((p) => p.slug).sort();
    const drawn = files.map((f) => f.slice(0, -4)).sort();
    expect(slugs.filter((s) => !drawn.includes(s))).toEqual([]);
    expect(drawn.filter((s) => !slugs.includes(s))).toEqual([]);
  });

  it('every icon passes the style linter (no ids, scripts, images, styles or hrefs; the kit palette)', () => {
    const failures = files
      .map((f) => [f, lint(readFileSync(join(ICONS, f), 'utf8')) as string[]] as const)
      .filter(([, problems]) => problems.length > 0);
    expect(failures).toEqual([]);
  });

  it('projectIcon() returns the inline markup by slug, and nothing for an unknown slug', () => {
    expect(projectIcon('nyaya')?.startsWith('<svg')).toBe(true);
    expect(projectIcon('nyaya')).toBe(readFileSync(join(ICONS, 'nyaya.svg'), 'utf8'));
    expect(projectIcon('no-such-project')).toBeUndefined();
  });
});

describe('cardText', () => {
  it('the description wins over the summary, as one plain line from its first paragraph', () => {
    expect(
      cardText({
        description:
          '### What it does\n\nTurns **legal** problems into\n*organised* cases.\n\nSecond paragraph.',
        summary: 'A summary.',
      }),
    ).toBe('Turns legal problems into organised cases.');
  });

  it('cuts a long first paragraph at 160 characters on a word boundary', () => {
    const text = cardText({ description: 'word '.repeat(60) })!;
    expect(text.length).toBeLessThanOrEqual(161);
    expect(text.endsWith('…')).toBe(true);
  });

  it('falls back to the summary, but never to the generated "Built at … · date" line', () => {
    expect(cardText({ description: null, summary: 'Matches citizens to schemes.' })).toBe(
      'Matches citizens to schemes.',
    );
    expect(cardText({ description: '- only\n- a list', summary: 'The summary.' })).toBe(
      'The summary.',
    );
    expect(cardText({ summary: 'Built at Claude Code Impact Lab · 20 Sep 2026' })).toBeNull();
    expect(cardText({ description: '', summary: '' })).toBeNull();
    expect(cardText({})).toBeNull();
  });
});

describe('cardProps', () => {
  it('maps the directory DTO (links.live/repo/video)', () => {
    expect(
      cardProps(
        {
          slug: 'nyaya',
          title: 'nyaya',
          description: 'An AI legal assistant.',
          summary: 'Built at X · 20 Sep 2026',
          links: {
            live: 'https://nyaya.example/',
            repo: 'https://github.com/x/nyaya',
            video: null,
          },
        },
        { size: 'lg' },
      ),
    ).toEqual({
      slug: 'nyaya',
      title: 'nyaya',
      text: 'An AI legal assistant.',
      links: { live: 'https://nyaya.example/', repo: 'https://github.com/x/nyaya', video: null },
      size: 'lg',
    });
  });

  it('maps a record-set project (url/repoUrl/videoUrl)', () => {
    const p = projects.find((x) => x.slug === 'nyaya')!;
    const card = cardProps(p, { level: 'h4' });
    expect(card).toMatchObject({ slug: 'nyaya', title: p.title, level: 'h4' });
    expect(card.links).toEqual({
      live: p.url ?? null,
      repo: p.repoUrl ?? null,
      video: p.videoUrl ?? null,
    });
    expect(card.text).toBe(cardText(p));
    expect(cardProps({ slug: 'x', title: 'X', summary: 'S' })).toEqual({
      slug: 'x',
      title: 'X',
      text: 'S',
      links: { live: null, repo: null, video: null },
    });
  });
});

describe('eventPlate', () => {
  it("the event's cover first, then its kit plate by slug, else nothing", () => {
    expect(asset('covers/cover-vol01.jpg')).toBeDefined();
    expect(asset('plates/claude-code-build-day-fable.jpg')).toBeDefined();
    expect(
      eventPlate({ slug: 'claude-code-build-day-fable', coverImage: 'covers/cover-vol01.jpg' }),
    ).toBe(asset('covers/cover-vol01.jpg'));
    expect(eventPlate({ slug: 'claude-code-build-day-fable', coverImage: null })).toBe(
      asset('plates/claude-code-build-day-fable.jpg'),
    );
    expect(
      eventPlate({ slug: 'claude-code-build-day-fable', coverImage: 'covers/missing.jpg' }),
    ).toBe(asset('plates/claude-code-build-day-fable.jpg'));
    expect(eventPlate({ slug: 'no-such-event' })).toBeUndefined();
  });
});

/**
 * Source checks for the two components, since the test runner does not compile .astro files.
 */
describe('component markup (review fixes)', () => {
  const card = readFileSync('src/components/ProjectCard.astro', 'utf8');
  const feature = readFileSync('src/components/EventFeature.astro', 'utf8');

  it('a card link name starts with its visible word (WCAG 2.5.3 label in name)', () => {
    expect(card).toContain(
      'aria-label={`${a.shown}: ${a.label} for ${title}, opens in a new tab`}',
    );
    expect(card).toMatch(/>\s*\{a\.shown\}\s*<\/a>/);
  });

  it('the card links get a taller touch target without changing the card height', () => {
    expect(card).toMatch(
      /@media \(pointer: coarse\) \{\s*\.pcard-links a \{\s*padding-block: 8px;\s*margin-block: -2px;/,
    );
  });

  it('the rail hides its scrollbar only when JS can drive the arrows', () => {
    const rail = readFileSync('src/components/ProjectRail.astro', 'utf8');
    expect(rail).toMatch(/:global\(\.js\) \.rail \{\s*scrollbar-width: none;/);
    expect(rail).toContain(':global(.js) .rail::-webkit-scrollbar {');
    expect(rail.match(/scrollbar-width: none/g)).toHaveLength(1);
  });

  it('member-supplied links are nofollow ugc, as on the project page', () => {
    expect(card).toContain('rel="noopener noreferrer nofollow ugc"');
  });

  it('the lead has no line break between </time> and its comma (Astro would render a space)', () => {
    expect(feature).toMatch(/<\/time>, \{hours\}, in \{city\}\./);
  });

  it("the event title links to the event's own page", () => {
    expect(feature).toContain('<a href={`/events/${event.slug}/`}>{event.title}</a>');
  });

  it('the Luma check cannot throw on a registration value that is not a URL', () => {
    expect(feature).not.toMatch(/new URL\(/);
    const onLuma = /^https?:\/\/([^/?#]+\.)?(luma\.com|lu\.ma)([/?#:]|$)/i;
    expect(feature).toContain(onLuma.source);
    expect(onLuma.test('https://luma.com/abc')).toBe(true);
    expect(onLuma.test('https://lu.ma/abc')).toBe(true);
    expect(onLuma.test('lu.ma/abc')).toBe(false);
    expect(onLuma.test('https://evil-luma.com/x')).toBe(false);
    expect(onLuma.test('https://luma.com.evil.test/x')).toBe(false);
  });
});
