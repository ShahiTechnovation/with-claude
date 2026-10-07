/**
 * EVERY INTERNAL PAGE LINK ENDS IN `/`.
 *
 * `trailingSlash: 'always'` (astro.config.mjs) and `"trailingSlash": true`
 * (vercel.json) make a page's slash-less address a 308 to the slashed one, so a
 * link that drops the slash costs every click a redirect and shows a crawler two
 * URLs for one page. Links come from the hrefs the data layer and the search
 * index build, from breadcrumbs and structured data, and from templates and
 * scripts, and this checks each. `/api/` routes and files (`/og-card.jpg`) are
 * not pages and are skipped.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { participationPaths } from '../src/data';
import { RecordSelectors } from '../src/data/selectors';
import { tsRecordSet } from '../src/data/source-ts';
import { buildSearchIndex } from '../src/lib/search';
import { itemListSchema, trail, websiteSchema } from '../src/lib/seo';

/** A root-relative page path whose path part (before `?` or `#`) has no trailing slash. */
function slashless(href: string): boolean {
  const path = href.replace(/\$\{[^}]*\}/g, 'x').split(/[?#]/)[0]!;
  return /^\/(?!\/|api\/)/.test(path) && !path.endsWith('/') && !/\.\w+$/.test(path);
}

describe('internal page links end in a slash', () => {
  it('in the hrefs the data layer builds', () => {
    // The TypeScript record has no stories, use cases, guides or dated builders,
    // and no Ambassador without a builder record (the only kind search lists on
    // its own), so one stand-in of each puts every kind of feed entry and search
    // record through its href.
    const one = {
      status: 'published',
      slug: 'x',
      name: 'X',
      title: 'X',
      citySlug: 'bhopal',
      date: '2026-01-01',
      createdAt: '2026-01-01',
      published: '2026-01-01',
      roles: [],
      kind: 'essay',
      category: 'workflow',
      tools: [],
      author: { name: 'X' },
    };
    const rs = {
      ...tsRecordSet(),
      ambassadors: [one],
      builders: [one],
      stories: [one],
      useCases: [one],
      guides: [one],
    };
    const selectors = new RecordSelectors(rs as never);
    const index = buildSearchIndex(selectors);
    const hrefs = [
      ...selectors.timeline().flatMap((month) => month.entries.map((e) => e.href)),
      ...index.map((record) => record.href),
      ...participationPaths.map((path) => path.url),
    ].filter((href): href is string => Boolean(href));

    expect(new Set(index.map((record) => record.id.split(':')[0]))).toEqual(
      new Set(['person', 'ambassador', 'project', 'event', 'city', 'use-case', 'story', 'guide']),
    );
    expect(hrefs.filter(slashless)).toEqual([]);
  });

  it('in breadcrumbs and structured data, whatever path the page passes in', () => {
    // Pages hand `trail()` and `itemListSchema()` bare paths ('/events'); the slash is added there.
    expect(
      trail({ name: 'Events', href: '/events' }, { name: 'X', href: '/events/x/' }).map(
        (c) => c.href,
      ),
    ).toEqual(['/', '/events/', '/events/x/']);
    const list = itemListSchema([{ name: 'X', href: '/guides/x' }], 'Guides') as {
      itemListElement: { url: string }[];
    };
    expect(list.itemListElement[0]!.url).toMatch(/\/guides\/x\/$/);
    expect(JSON.stringify(websiteSchema())).toContain('/discover/?q={search_term_string}');
  });

  it('in the links and form actions written into templates and scripts', () => {
    // href="/x", href={`/x/${y}`}, href={cond ? `/x/${y}` : z}, a form's action="/x", and a script's el.href = `/x/${y}`
    const HREF = /(?:href|action)=(?:"([^"]*)"|\{(?:[^{}`\n]*\?\s*)?`([^`]*)`)|\.href = `([^`]*)`/g;
    const bad = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(astro|tsx)$/.test(file) || /^scripts[\\/].*\.ts$/.test(file))
      .flatMap((file) =>
        [...readFileSync(join('src', file), 'utf8').matchAll(HREF)]
          .map((m) => (m[1] ?? m[2] ?? m[3])!)
          .filter(slashless)
          .map((href) => `${file}: ${href}`),
      );

    expect(bad).toEqual([]);
  });
});
