/**
 * THE PROJECT PAGES: /projects/ and /projects/[slug]/.
 *
 * Split out of `homepage-routing.test.ts`, then moved to the Cinematic dark layout
 * (plan 4.1 and 4.2): event groups of cards on /projects/, the icon-tile head on a project.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// LF regardless of how the checkout was made (core.autocrlf on Windows).
const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('the project directory at /projects/', () => {
  const index = source('src/pages/projects/index.astro');
  const detail = source('src/pages/projects/[slug].astro');
  const builder = source('src/pages/builders/[slug].astro');

  it('is its own server-rendered page, never a redirect', () => {
    expect(index).toContain('export const prerender = false;');
    expect(index).not.toMatch(/Astro\.redirect\(/);
    expect(index).toContain('projectArchive(Astro.url.searchParams)');
  });

  it('counts projects for its lead the way the homepage does: those built at a public event', () => {
    expect(index).toContain(
      "`${plural(atEvents, 'project')} built at ${plural(eventCount, 'event')}",
    );
    const home = source('src/components/home/MadeWith.astro');
    expect(home).toMatch(
      /p\.builtAtEventSlug && selectors\.eventBySlug\.has\(p\.builtAtEventSlug\)/,
    );
  });

  it('lists in its ItemList every card the grouped view shows, not just the first page', () => {
    expect(index).toContain('const listed = grouped ? groups.flatMap((g) => g.items) : items;');
    expect(index).toMatch(/itemListSchema\(\s*listed\.map\(/);
  });

  it("keeps the line breaks in a team's own 'Built with' answer", () => {
    expect(detail).toContain('<dd class="pd-built-with">{project.builtWith}</dd>');
    expect(detail).toMatch(/\.pd-built-with \{\s*white-space: pre-line;/);
  });

  it('answers a missing or hidden project with a real 404, not a redirect', () => {
    expect(detail).not.toMatch(/Astro\.redirect\(/);
    expect(detail).toMatch(/Astro\.rewrite\('\/not-found\/'\)|Astro\.response\.status = 404/);
  });

  /** Directory styles load on the routes that use them, never site-wide. */
  it('keeps directory.css off the shared layout and the homepage', () => {
    expect(source('src/layouts/Base.astro')).not.toContain('directory.css');
    const css = source('src/styles/directory.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // No bare element or shared-primitive selector, at the top level or inside a media query.
    const selectors = [...css.matchAll(/(?:^|[{}])\s*([^{}@;]+?)\s*\{/g)].flatMap((m) =>
      m[1]!.split(',').map((s) => s.trim()),
    );
    expect(selectors.length).toBeGreaterThan(60);
    for (const selector of selectors) {
      expect(selector, selector).not.toMatch(
        /^(html|body|main|header|footer|section|a|h[1-6]|p|ul|ol|button|input)\b/,
      );
      expect(selector, selector).not.toMatch(
        /^\.(btn|section|section-head|container|container-wide|eyebrow|prose|plate|label|link-arrow)\b/,
      );
    }
  });

  it('the default view is one group per event; anything else is a flat grid with the count', () => {
    expect(index).toContain('<PageIntro title="Made with Claude." size="lg">');
    expect(index).toContain('await projectGroups()');
    // Only the unfiltered first page in the default order is grouped.
    expect(index).toMatch(/unfiltered && query\.page === 1 && query\.sort === 'event'/);
    expect(index).toContain('<ProjectGroup');
    expect(index).toContain('plate={eventPlate(g.event)}');
    expect(index).toContain('<ProjectGrid items={items.map((p) => cardProps(p))} level="h3" />');
    expect(index).toMatch(/\{!grouped && pageCount > 1 && \(/);
    expect(index).toContain('Nothing matches that yet.');
    expect(index).toContain('Built something with Claude?');
    expect(index).toContain('href="/me/projects/new/"');
    // Filtered and paged views stay out of the index.
    expect(index).toContain('noindex={filtered || page > 1}');
  });

  it('"Show N more" stays one line on a phone; the accessible name keeps the event', () => {
    const group = source('src/components/ProjectGroup.astro');
    const grid = source('src/components/ProjectGrid.astro');
    expect(group).toContain('more={`Show ${items.length - visible} more`}');
    expect(group).toContain('moreTail={` from ${title}`}');
    // The tail is visually hidden under 700px, never display: none, so it stays in the name.
    expect(grid).toContain('{moreTail && <span class="more-tail">{moreTail}</span>}');
    const narrow = grid.slice(grid.indexOf('@media (max-width: 699.98px)'));
    expect(narrow).toMatch(/\.more-tail \{[^}]*clip-path: inset\(50%\);/);
    expect(narrow.match(/\.more-tail \{([^}]*)\}/)?.[1]).not.toMatch(/display:\s*none/);
  });

  it('no list rows, badges, logos or cover art on either page', () => {
    for (const page of [index, detail]) {
      expect(page).not.toMatch(/\b(ProjectRow|EventBadge|ProjectLogo|ProjectCover)\b|<Image\b/);
    }
    expect(detail).toContain('projectIcon(project.slug)');
    // The member's image is the share image only.
    expect(detail).toContain('image={shareImage}');
  });

  it('a project page says where it was built in one sentence, linked to the event', () => {
    expect(detail).toContain('From <a href={eventHref}>{eventName}</a>');
    expect(detail).toMatch(
      /name: project\.event\.label, href: `\/events\/\$\{project\.event\.slug\}\/`/,
    );
    expect(detail).toContain("All {plural(eventTotal, 'project')} from {project.event.label}");
  });

  it('the Report button renders only when JS can open its dialog, on both pages', () => {
    // Without the js-only wrapper a visitor with scripts off would see a Report button that does nothing.
    expect(detail).toMatch(
      /<div class="js-only">\s*<ReportModal\s+client:visible=\{\{ rootMargin: '600px' \}\}\s+entityType="project"/,
    );
    expect(builder).toMatch(
      /<div class="js-only">\s*<ReportModal\s+client:visible=\{\{ rootMargin: '600px' \}\}\s+entityType="builder"/,
    );
  });

  it('on the builder foot the wrapper is a flex item, so Report shares a baseline with "All builders"', () => {
    // As a block its line box is 3px taller than the link beside it, which drops the text 1.5px.
    // base.css still hides it without JS (display: none !important), so this does not show it there.
    expect(builder).toMatch(/\.foot \.js-only \{\s*display: flex;/);
  });

  it('both pages hydrate the Report button the same way: a screen before it shows', () => {
    const directive = /<ReportModal\s+client:visible=\{\{ rootMargin: '600px' \}\}\s+entityType=/;
    expect(builder).toMatch(directive);
    expect(detail).toMatch(directive);
    // `client:load` would ship React on every builder view; a bare `client:visible` waits for the
    // button to be on screen, so the first Enter on it is lost.
    expect(builder + detail).not.toMatch(/<ReportModal[^>]*client:load/);
    expect(source('src/components/react/ReportModal.tsx')).toContain(
      "`client:visible={{ rootMargin: '600px' }}`",
    );
  });

  it('the Report link on projects.withclaude.in is the same flush text link as the button', () => {
    expect(detail).toMatch(/<a\s+class="link"\s+href=\{`\$\{MAIN_ORIGIN\}\/projects\//);
  });

  it('a <button class="link"> sits flush because .link has no side padding', () => {
    // Without it the browser's own 6px of button padding puts the text 6px in from its column.
    const link = source('src/styles/primitives.css').match(/\n\.link \{([^}]*)\}/)?.[1] ?? '';
    expect(link).toMatch(/padding:\s*0 0 3px;/);
  });

  it('keeps a 44px tap target on .link under a coarse pointer, so the 25px Report link stays easy to tap', () => {
    // On a phone the link's invisible ::before is the hit area, positioned against .link itself.
    const css = source('src/styles/primitives.css');
    const coarse = [...css.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)]
      .map((m) => m[1]!.replace(/\/\*[\s\S]*?\*\//g, ''))
      .join('\n');
    expect(coarse, 'a @media (pointer: coarse) block').not.toBe('');
    // The body of the rule whose selector list names `selector` exactly, wherever it sits in the list.
    const rule = (selector: string) =>
      [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, list]) =>
        list!.split(',').some((s) => s.trim() === selector),
      )?.[2] ?? '';
    expect(rule('.link')).toMatch(/position:\s*relative;/);
    expect(rule('.link::before')).toMatch(/position:\s*absolute;/);
    expect(rule('.link::before')).toMatch(/height:\s*44px;/);
  });
});

describe('the home page project rail in print', () => {
  const rail = source('src/components/ProjectRail.astro');
  const print = rail.slice(rail.indexOf('@media print'));

  it('prints every card in a two-column grid instead of a scrolling row', () => {
    expect(print).toMatch(/\.rail \{[^}]*grid-auto-flow: row;/);
    expect(print).toMatch(/\.rail \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(print).toMatch(/\.rail \{[^}]*overflow: visible;/);
    expect(print).toMatch(/\.rail \{[^}]*margin-inline: 0;[^}]*padding-inline: 0;/);
    // Three rows can straddle a page; a card moves whole instead of being sliced.
    expect(print).toMatch(/\.rail > :global\(\.pcard\) \{\s*break-inside: avoid;/);
  });

  it('drops the scroll arrows, with the specificity of the rule that shows them', () => {
    expect(rail).toMatch(/:global\(\.js\) \.rail-arrows \{\s*display: flex;/);
    expect(print).toMatch(/:global\(\.js\) \.rail-arrows \{\s*display: none;/);
    // Later in the file than the 700px rule that shows them, so it wins.
    expect(rail.lastIndexOf('display: none;')).toBeGreaterThan(rail.lastIndexOf('display: flex;'));
  });
});
