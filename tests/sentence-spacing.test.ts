/**
 * NO SPACE BEFORE PUNCTUATION. Astro 7's compiler, with `compressHTML: true`, keeps a line break
 * after an inline element as a space; Astro 5's dropped it. Prettier puts an `{expression}` that
 * follows an element on a line of its own, so after the upgrade three sentences read "Hosted by
 * Aniket Sahu .", "From Claude Impact Lab , Bhopal" and "created a project . It is".
 *
 * Those pages read the database (the admin one also needs a session), so this does not render
 * them through the app. It compiles each template the way the build does (the compiler astro
 * uses, `compact: true`), evaluates the sentence's compiled template with sample values, and
 * reads its text as a browser does: tags dropped, whitespace collapsed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const fromAstro = createRequire(createRequire(import.meta.url).resolve('astro/package.json'));
const { transform } = (await import(fromAstro.resolve('@astrojs/compiler-rs'))) as {
  transform: (source: string, options: { compact: boolean; filename: string }) => { code: string };
};

const compile = (file: string) =>
  transform(readFileSync(file, 'utf8'), { compact: true, filename: file }).code;

/** The visible text of the compiled sentence from `start` to its `</p>`, given the template's values. */
function sentence(file: string, start: string, values: Record<string, unknown>) {
  const code = compile(file);
  const from = code.indexOf(start);
  expect(from, `${start} in ${file}`).toBeGreaterThan(-1);
  const body = code.slice(from, code.indexOf('</p>', from));
  // The compiled body is a template literal from this repo's own templates, nothing from outside.
  const html = new Function(...Object.keys(values), `return \`${body}\`;`)(
    ...Object.values(values),
  );
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('sentences that end on an inline element', () => {
  it('both configs compile with compressHTML: true, which these checks assume', () => {
    for (const config of ['astro.config.mjs', 'admin/astro.config.mjs']) {
      expect(readFileSync(config, 'utf8'), config).toMatch(/^\s*compressHTML: true,$/m);
    }
  });

  it('the event feature: "Hosted by <name>." with and without organisations', () => {
    const host = { name: 'Aniket Sahu' };
    const file = 'src/components/EventFeature.astro';
    expect(sentence(file, 'Hosted by', { host, organisations: '' })).toBe('Hosted by Aniket Sahu.');
    expect(sentence(file, 'Hosted by', { host, organisations: 'GDG Bhopal' })).toBe(
      'Hosted by Aniket Sahu, with GDG Bhopal.',
    );
  });

  it('the project page: "From <event>, <city>, <date>."', () => {
    const text = sentence('src/pages/projects/[slug].astro', 'From <a', {
      $$addAttribute: () => '',
      eventHref: '/events/claude-code-impact-lab-october/',
      eventName: 'Claude Impact Lab',
      eventRest: 'Bhopal, 11 October 2026.',
    });
    expect(text).toBe('From Claude Impact Lab, Bhopal, 11 October 2026.');
  });

  it('the admin submission page: "created a <type>. It is not published"', () => {
    const text = sentence('admin/src/pages/submissions/[id].astro', 'This submission created', {
      createdType: 'project',
    });
    expect(text).toMatch(
      /^This submission created a project\. It is not published by being created/,
    );
  });

  it('no template puts a line break between an inline element and the punctuation after it', () => {
    const files = ['src', 'admin/src'].flatMap((dir) =>
      readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.astro'))
        .map((f) => join(dir, f)),
    );
    expect(files.length).toBeGreaterThan(80);
    const close = /<\/(a|abbr|b|cite|code|em|i|mark|q|small|span|strong|time)>\s+[.,;:!?)]/g;
    const found = files.flatMap((file) =>
      [...compile(file).matchAll(close)].map((m) => `${file}: ${JSON.stringify(m[0])}`),
    );
    expect(found).toEqual([]);
  });
});
