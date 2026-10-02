import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles/fonts.css', 'utf8');

describe('the official display faces', () => {
  it('points every @font-face at a file that exists', () => {
    // An unresolved url() survives the build unchanged and fails silently in the browser.
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(existsSync(resolve('src/styles', url)), url).toBe(true);
  });

  it('gives the display serif a real italic face, so italics are never faked', () => {
    expect(css).toMatch(/font-family: 'Anthropic Serif Display';[^}]*font-style: italic/);
  });
});
