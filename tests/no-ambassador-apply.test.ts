/**
 * No source file links to the Ambassador application, uses its button label,
 * or tells a visitor to apply to or through Anthropic.
 *
 * Hosting is Anthropic's programme. The site says so and links nowhere for it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (readdirSync('src', { recursive: true }) as string[])
  .filter((f) => /\.(astro|ts|tsx|js|mjs)$/.test(f))
  .map((f) => join('src', f));

describe('the Ambassador apply links', () => {
  it('are gone from every source file', () => {
    const hits = files.filter((f) =>
      /ambassadorProgramUrl|community\/ambassadors?\b|Become an? (Claude )?Ambassador|apply (to|through) Anthropic/i.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(hits).toEqual([]);
  });
});
