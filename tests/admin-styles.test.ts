import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The admin loads one stylesheet, `admin/src/styles/admin.css`, plus each page's own <style>.
 * There is no Tailwind. Five admin pages were once written in Tailwind utilities and rendered
 * unstyled, with nothing to say so. Any static class name in admin markup must be defined in one
 * of those two places, or it is styling that never arrives.
 */
const css = readFileSync('admin/src/styles/admin.css', 'utf8');
const pages = readdirSync('admin/src', { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.astro'))
  .map((f) => join('admin/src', f));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\:/]/g, '\\$&');

describe('admin markup only uses classes that have a rule', () => {
  it.each(pages)('%s', (file) => {
    const src = readFileSync(file, 'utf8');
    const own = (src.match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n');
    const template = src.split(/^---$/m).slice(2).join('---');
    const used = [...template.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) =>
      m[1].split(/\s+/).filter(Boolean),
    );
    const undefinedClasses = [...new Set(used)].filter((name) => {
      const rule = new RegExp(`\\.${escape(name)}(?![\\w-])`);
      return !rule.test(css) && !rule.test(own);
    });
    expect(undefinedClasses).toEqual([]);
  });
});
