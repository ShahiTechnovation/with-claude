/**
 * THE USE CASE AND GUIDE PAGES: facts the page head used to carry.
 *
 * The page head lost its eyebrow and stamp, so the category (use cases) and the reading time
 * (guides) live below the h1 instead. Neither route has a published record yet, so this reads the
 * templates.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('use case and guide pages', () => {
  it('show a use case’s category in the byline facts', () => {
    const page = source('src/pages/use-cases/[slug].astro');
    expect(page).toContain('<dt class="label">Category</dt>');
    expect(page).toContain('<dd>{formatName(useCase.category)}</dd>');
  });

  it('show a guide’s reading time next to its published date', () => {
    const page = source('src/pages/guides/[slug].astro');
    expect(page).toContain('{guide.readingMinutes && ` · ${guide.readingMinutes} min read`}');
  });
});
