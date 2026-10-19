/**
 * ONE TITLE CONVENTION.
 *
 * Every `<title>` but home's ends in ` | WITH CLAUDE` (home starts with it): the `titles`
 * templates in seo.ts, and Base.astro's default for pages that pass only `title`. No page hands
 * a `titles.*()` result to `title`, which would add the suffix twice. Each of the seven account
 * pages renders one `<Base>` for both states, so signed out it keeps its own title and
 * description (not "Sign in"); `projects/[id]/edit` alone keeps "Sign in", because it has no
 * title until the project loads.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { titles } from '../src/lib/seo';

const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** Each `<Base …>` opening tag in a page's markup, read up to the first `>` outside `{…}`. */
const baseTags = (path: string) => {
  const markup = source(path).split(/^---$/m).slice(2).join('---');
  return [...markup.matchAll(/<Base\b/g)].map(({ index = 0 }) => {
    let end = index;
    for (let depth = 0; end < markup.length; end++) {
      if (markup[end] === '{') depth++;
      else if (markup[end] === '}') depth--;
      else if (markup[end] === '>' && depth === 0) break;
    }
    return markup.slice(index, end + 1);
  });
};

describe('page titles', () => {
  it('end with the wordmark, and home starts with it', () => {
    for (const [name, build] of Object.entries(titles)) {
      const title = (build as (...a: string[]) => string)('Name', 'Place');
      if (name === 'home') expect(title.startsWith('WITH CLAUDE | ')).toBe(true);
      else expect(title, name).toMatch(/ \| WITH CLAUDE$/);
    }
  });

  it("default to `title | wordmark` when a page doesn't set seoTitle", () => {
    const base = source('src/layouts/Base.astro');
    expect(base).toContain('const fullTitle = seoTitle ?? `${title} | ${site.wordmark}`;');
    expect(base).not.toContain('· With Claude');
    expect(base).not.toContain('· India');
  });

  it('never carry the suffix twice: a titles.*() or wordmark title comes with seoTitle', () => {
    const pages = readdirSync('src/pages', { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.astro'))
      .map((file) => join('src/pages', file));
    for (const page of pages) {
      const tags = baseTags(page);
      if (source(page).includes('import Base from')) expect(tags.length, page).toBeGreaterThan(0);
      for (const tag of tags) {
        if (/\btitle=\{[^}]*\b(titles\.|site\.wordmark)/.test(tag)) {
          expect(tag, page).toMatch(/\bseoTitle=/);
        }
      }
    }
  });

  it('keep each account page title when signed out: one <Base>, noindex', () => {
    for (const page of [
      'index',
      'settings',
      'profile/index',
      'profile/edit',
      'projects/index',
      'projects/new',
      'projects/claim',
    ]) {
      const tags = baseTags(`src/pages/me/${page}.astro`);
      expect(tags, page).toHaveLength(1);
      expect(tags[0], page).toMatch(/\btitle="[^"]+"/);
      expect(tags[0], page).not.toContain('title="Sign in"');
      expect(tags[0], page).toMatch(/\bnoindex\b/);
    }
  });
});
