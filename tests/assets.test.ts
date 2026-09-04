import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

/**
 * The icons.
 *
 * `favicon.png` and `apple-touch-icon.png` were byte-identical copies of the
 * full-size logo — 1254×1254 and 487 KB each, downloaded by every visitor to
 * be drawn at sixteen pixels. These assert the fix and, more usefully, stop it
 * happening again the next time somebody copies a file rather than resizing
 * one.
 */
const LOGO = 'public/logo.png';
const FAVICON = 'public/favicon.png';
const APPLE = 'public/apple-touch-icon.png';

/** A 64px icon has no business being larger than this. */
const FAVICON_MAX_BYTES = 32 * 1024;
const APPLE_MAX_BYTES = 64 * 1024;

describe('icon assets', () => {
  it('is not a copy of the full-size logo', () => {
    const logo = readFileSync(LOGO);
    expect(readFileSync(FAVICON).equals(logo), 'favicon.png is a copy of logo.png').toBe(false);
    expect(readFileSync(APPLE).equals(logo), 'apple-touch-icon.png is a copy of logo.png').toBe(
      false,
    );
  });

  it('is small enough to be worth downloading', () => {
    expect(statSync(FAVICON).size).toBeLessThan(FAVICON_MAX_BYTES);
    expect(statSync(APPLE).size).toBeLessThan(APPLE_MAX_BYTES);
  });

  it('is the size the markup declares', async () => {
    // `<link rel="icon" sizes="64x64">` in Base.astro.
    const head = readFileSync('src/layouts/Base.astro', 'utf8');
    expect(head).toMatch(/rel="icon"[^>]*sizes="64x64"[^>]*href="\/favicon\.png"/);

    const favicon = await sharp(FAVICON).metadata();
    expect(favicon.width).toBe(64);
    expect(favicon.height).toBe(64);
  });

  it('gives the Apple touch icon the size and opacity iOS expects', async () => {
    const apple = await sharp(APPLE).metadata();
    expect(apple.width).toBe(180);
    expect(apple.height).toBe(180);
    // iOS composites transparency over black, which would put the orange mark
    // on a black square. It is flattened onto the site's paper instead.
    expect(apple.hasAlpha).toBe(false);
  });

  it('leaves the main logo alone', async () => {
    const logo = await sharp(LOGO).metadata();
    expect(logo.width).toBe(1254);
    expect(logo.height).toBe(1254);
  });

  it('is still referenced by the layout', () => {
    const head = readFileSync('src/layouts/Base.astro', 'utf8');
    expect(head).toMatch(/href="\/favicon\.png"/);
    expect(head).toMatch(/rel="apple-touch-icon"[^>]*href="\/apple-touch-icon\.png"/);
  });
});
