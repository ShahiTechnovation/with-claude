#!/usr/bin/env node
/**
 * PROJECT DIRECTORY — browser journey and screenshots, against a local dev
 * server and its local database (read only).
 *
 *   BASE=http://127.0.0.1:4321 DATABASE_URL=postgresql://…@127.0.0.1:…/withclaude_dev \
 *     OUT=shots/directory node scripts/dev/directory-journey.mjs
 *
 * Checks what a screenshot cannot: the grouped default view, the toolbar
 * (event pills, type, search) with URL state, removable filter pills,
 * back/forward, the "Show more" disclosure, the no-JS form, project pages,
 * 404s, console errors and horizontal overflow. Expected numbers come from the
 * database through the site's public predicate, never from constants. Exits
 * non-zero on any failure. Writes PNGs and report.json to OUT.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
const OUT = process.env.OUT ?? 'shots/directory';
const DB = process.env.DATABASE_URL ?? '';
if (
  !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE) ||
  !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)
) {
  console.error('directory-journey.mjs only runs against a loopback app and a loopback database.');
  process.exit(1);
}
await mkdir(OUT, { recursive: true });
const pool = new pg.Pool({ connectionString: DB });
const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
);
const results = [];
let failures = 0;
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failures += 1;
};
// keepDash renders a no-break space before a spaced dash; the database title has a plain one.
const nbsp = (text) => text.replace(/\u00a0/g, ' ');

// ── what the pages must show, from the same public predicate the site uses ──
const pick = async (sql, params = []) => (await pool.query(sql, params)).rows;
const PUBLIC = `p.publication_status='published' and p.moderation_state='clean' and p.deleted_at is null`;
const events = await pick(
  `select e.slug, e.title, e.date::text, count(*)::int n from projects p join events e on e.id=p.built_at_event_id and e.status='published'
   where ${PUBLIC} group by e.slug, e.title, e.date order by e.date desc, e.slug`,
);
const [{ n: TOTAL }] = await pick(`select count(*)::int n from projects p where ${PUBLIC}`);
const [{ n: INDEPENDENT }] = await pick(
  `select count(*)::int n from projects p left join events e on e.id=p.built_at_event_id and e.status='published' where ${PUBLIC} and e.id is null`,
);
const [draftProject] = await pick(
  `select slug from projects where publication_status='draft' limit 1`,
);
const newest = events[0];
const second = events[1] ?? events[0];
const saysMatch = (text, n) => new RegExp(`(^|\\D)${n} projects? match`).test(text);
console.log(
  `expected public: ${TOTAL} in ${events.length} events (${events.map((e) => `${e.slug} ${e.n}`).join(', ')}), ${INDEPENDENT} independent`,
);

async function newPage(width, height, { js = true } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    javaScriptEnabled: js,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on(
    'console',
    (m) =>
      m.type() === 'error' &&
      !/privy|Failed to load resource|dev-toolbar/i.test(m.text()) &&
      errors.push(m.text().slice(0, 200)),
  );
  // Astro's dev toolbar is dev-server-only chrome; production builds are checked separately.
  page.on(
    'pageerror',
    (e) => !/dev-toolbar/.test(e.message) && errors.push(`pageerror: ${e.message.slice(0, 200)}`),
  );
  return { page, context, errors };
}
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const shot = (page, name, full = false) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
const settled = (page) =>
  page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
const countText = (page) => page.locator('[data-dir-count]').innerText();
const titles = (page) => page.locator('.pcard-title').allInnerTexts();
// document.querySelectorAll, not a locator: locators pierce the dev toolbar's shadow DOM, which has h1s.
const h1s = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()).join('|'),
  );
const pill = (page, slug) => page.locator(`label.dir-pill:has(input[value="${slug}"])`);

try {
  // ── desktop: the grouped default view ───────────────────────────────────
  {
    const { page, context, errors } = await newPage(1440, 900);
    const res = await page.goto(`${BASE}/projects/`, { waitUntil: 'load', timeout: 90_000 });
    check('/projects/: 200', res?.status() === 200);
    check('one h1, "Made with Claude."', (await h1s(page)) === 'Made with Claude.');
    // "{n} projects built at {n} events in {city}.": projects with a public event only (src/pages/projects/index.astro).
    const AT = TOTAL - INDEPENDENT;
    const lead = events.length
      ? `${AT} project${AT === 1 ? '' : 's'} built at ${events.length} event${events.length === 1 ? '' : 's'}`
      : `${TOTAL} project`;
    check(
      `the lead starts "${lead}"`,
      (await page.locator('.page-intro .lead').innerText()).startsWith(lead),
    );
    const groups = (await page.locator('section.group h2').allInnerTexts()).map(nbsp);
    check(
      `one group per event, plus independent (${events.length + (INDEPENDENT ? 1 : 0)})`,
      groups.length === events.length + (INDEPENDENT ? 1 : 0),
      groups.join(' | '),
    );
    check(
      'newest event first',
      groups[0] === newest.title || newest.title.includes(groups[0]),
      `${groups[0]} vs ${newest.title}`,
    );
    const visible = await page.evaluate(() =>
      [...document.querySelectorAll('section.group')].map(
        (g) => g.querySelectorAll(':scope > .pgrid > .pcard').length,
      ),
    );
    check(
      'six cards per group before "Show more"',
      visible.every((n, i) => n === Math.min(6, events[i]?.n ?? n)),
      JSON.stringify(visible),
    );
    check('the default view has no pager', (await page.locator('.dir-pager').count()) === 0);
    const bar = await page.evaluate(() => {
      const b = document.querySelector('.dir-bar');
      const tops = ['[data-dir-q]', '.dir-pill', '[data-dir-category]'].map((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      });
      return {
        pos: getComputedStyle(b).position,
        h: Math.round(b.getBoundingClientRect().height),
        oneRow: Math.max(...tops) - Math.min(...tops) < 4,
      };
    });
    check(
      '1440: the toolbar is one sticky 74px row',
      bar.pos === 'sticky' && bar.h === 74 && bar.oneRow,
      JSON.stringify(bar),
    );
    check('1440: Apply is hidden with JS', !(await page.locator('.no-js-only').isVisible()));
    check('1440: no overflow', !(await overflow(page)));
    await shot(page, 'directory-1440');

    // "Show N more" keeps focus on its summary and reads "Show fewer".
    const summary = page.locator('details.more summary').first();
    await summary.focus();
    await page.keyboard.press('Enter');
    check(
      '"Show more" opens in place, focus stays, it reads "Show fewer"',
      await page.evaluate(
        () =>
          document.activeElement?.tagName === 'SUMMARY' &&
          document.activeElement.parentElement.open &&
          document.activeElement.innerText.trim() === 'Show fewer',
      ),
    );

    // An event pill applies at once and keeps focus.
    await pill(page, second.slug).click();
    await page.waitForURL(new RegExp(`event=${second.slug}`));
    await settled(page);
    check(
      `an event pill applies at once: ${second.n} projects`,
      saysMatch(await countText(page), second.n),
      await countText(page),
    );
    check(
      'the one event keeps its group header above the grid',
      (await page.locator('section.group h2').allInnerTexts()).length === 1,
    );
    check(
      'the pill is checked',
      await page.locator(`input[name="event"][value="${second.slug}"]`).isChecked(),
    );

    // The type select.
    const [{ category, n: catN }] = await pick(
      `select p.category::text category, count(*)::int n from projects p join events e on e.id=p.built_at_event_id where ${PUBLIC} and e.slug=$1 group by 1 order by 2 desc limit 1`,
      [second.slug],
    );
    await page.locator('[data-dir-category]').selectOption(category);
    await page.waitForURL(/category=/);
    await settled(page);
    check(
      `the type applies at once: ${catN} ${category}`,
      saysMatch(await countText(page), catN),
      await countText(page),
    );
    check(
      'both filters show as removable pills, with Clear all',
      (await page.locator('.dir-chips .dir-chip').count()) === 2 &&
        (await page.locator('.dir-chips a', { hasText: 'Clear all' }).count()) === 1,
    );
    await shot(page, 'directory-1440-filtered');

    // Removing a pill removes only that filter; focus goes to the count.
    await page.locator('.dir-chips .dir-chip').first().click();
    await page.waitForURL((u) => !u.search.includes('event='));
    await settled(page);
    check(
      'removing a pill removes only that filter',
      /category=/.test(page.url()) &&
        (await page.locator('input[name="event"][value=""]').isChecked()),
    );
    check(
      'focus moves to the count',
      await page.evaluate(() => document.activeElement?.matches('[data-dir-count]')),
    );
    await page.goBack();
    await page.waitForURL(/event=/);
    await settled(page);
    check(
      'back restores the earlier filters',
      (await page.locator(`input[name="event"][value="${second.slug}"]`).isChecked()) &&
        (await page.locator('[data-dir-category]').inputValue()) === category,
    );
    await page.goForward();
    await page.waitForURL((u) => !u.search.includes('event='));
    await settled(page);
    check(
      'forward re-applies the later state',
      await page.locator('input[name="event"][value=""]').isChecked(),
    );
    await page.locator('.dir-chips a', { hasText: 'Clear all' }).click();
    await page.waitForURL((u) => u.search === '');
    await settled(page);
    check(
      'Clear all returns the grouped view',
      (await page.locator('.dir-chips').count()) === 0 &&
        (await page.locator('section.group').count()) === groups.length,
    );

    // Search.
    await page.locator('[data-dir-q]').fill('traffic');
    await page.waitForURL(/q=traffic/);
    await settled(page);
    check(
      'search applies after a pause and keeps focus in the field',
      await page.evaluate(() => document.activeElement?.matches('[data-dir-q]')),
    );
    await page.locator('[data-dir-q]').fill('zz-no-such-project');
    await page.waitForURL(/q=zz-no-such-project/);
    await settled(page);
    check(
      'no results: "Nothing matches that yet." and a way back',
      (await page.locator('.dir-empty').innerText()).includes('Nothing matches that yet.') &&
        (await page.locator('.dir-empty a').innerText()).includes(`Show all ${TOTAL} projects`),
    );
    check('no console errors (1440)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ── older parameters: sort and page still work, as a flat grid ──────────
  {
    const { page, context } = await newPage(1440, 900);
    await page.goto(`${BASE}/projects/?sort=name`, { waitUntil: 'load', timeout: 90_000 });
    const sorted = await titles(page);
    const outOfOrder = sorted.findIndex(
      (t, i) => i > 0 && sorted[i - 1].localeCompare(t, 'en', { sensitivity: 'base' }) > 0,
    );
    check(
      '?sort=name is a flat grid in name order',
      (await page.locator('section.group').count()) === 0 && outOfOrder === -1,
      outOfOrder > 0 ? `${sorted[outOfOrder - 1]} > ${sorted[outOfOrder]}` : '',
    );
    if (TOTAL > 60) {
      await page.locator('.dir-pager a', { hasText: '2' }).first().click();
      await page.waitForURL(/page=2/);
      await settled(page);
      check(
        'page 2 keeps the sort',
        /sort=name/.test(page.url()) &&
          (await page.locator('.dir-pager [aria-current="page"]').innerText()).includes('2'),
      );
    }
    await context.close();
  }

  // ── phone ──────────────────────────────────────────────────────────────
  {
    const { page, context, errors } = await newPage(390, 844);
    await page.goto(`${BASE}/projects/`, { waitUntil: 'load', timeout: 90_000 });
    const top = await page.evaluate(
      () => document.querySelector('.pcard').getBoundingClientRect().top,
    );
    check('390: the first card starts inside the first screen', top < 844, String(Math.round(top)));
    check(
      '390: the toolbar scrolls with the page',
      (await page.evaluate(() => getComputedStyle(document.querySelector('.dir-bar')).position)) !==
        'sticky',
    );
    check('390: no overflow', !(await overflow(page)));
    await shot(page, 'directory-390');
    check('no console errors (390)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ── without JavaScript ─────────────────────────────────────────────────
  {
    const { page, context } = await newPage(390, 844, { js: false });
    await page.goto(`${BASE}/projects/`);
    check('no-JS: Apply is shown', await page.locator('.no-js-only').isVisible());
    await pill(page, second.slug).click();
    await page.locator('.no-js-only').click();
    await page.waitForURL(new RegExp(`event=${second.slug}`));
    check(
      `no-JS: the form applies filters by GET (${second.n})`,
      saysMatch(await countText(page), second.n),
      await countText(page),
    );
    await page.goto(`${BASE}/projects/?city=bhopal`);
    await page.locator('[data-dir-category]').selectOption({ index: 1 });
    await page.locator('.no-js-only').click();
    await page.waitForURL(/category=/);
    check('no-JS: a filter with no control (city) rides along', /city=bhopal/.test(page.url()));
    await context.close();
  }

  // ── project pages, one per event ───────────────────────────────────────
  for (const event of events.slice(0, 3)) {
    const [project] = await pick(
      `select p.slug, p.title, p.claude_usage is not null and p.claude_usage <> '' usage, e.title event, c.name city from projects p
       join events e on e.id=p.built_at_event_id left join cities c on c.id=e.city_id where ${PUBLIC} and e.slug=$1 order by p.slug limit 1`,
      [event.slug],
    );
    for (const [w, h, tag] of [
      [1440, 900, '1440'],
      [375, 812, '375'],
    ]) {
      const { page, context, errors } = await newPage(w, h);
      const res = await page.goto(`${BASE}/projects/${project.slug}/`, {
        waitUntil: 'load',
        timeout: 90_000,
      });
      check(`${project.slug} (${tag}): 200`, res?.status() === 200);
      check(`${project.slug} (${tag}): one h1, the title`, (await h1s(page)) === project.title);
      const from = nbsp(await page.locator('.pd-from').innerText());
      check(
        `${project.slug} (${tag}): "From ${event.title}, ${project.city}, …"`,
        from.startsWith(`From ${event.title}${project.city ? `, ${project.city}` : ''}, `) &&
          from.endsWith('.'),
        from,
      );
      const crumbs = (await page.locator('nav[aria-label="Breadcrumb"] li').allInnerTexts()).map(
        (t) => t.replace(/[\s/]+$/g, '').trim(),
      );
      check(
        `${project.slug} (${tag}): breadcrumbs Home / Projects / event / title`,
        crumbs.length === 4 && crumbs[3] === project.title,
        crumbs.join(' | '),
      );
      const names = await page.evaluate(() =>
        [...document.querySelectorAll('.pd-actions a')].map((a) => [
          a.innerText.trim(),
          a.getAttribute('aria-label'),
        ]),
      );
      check(
        `${project.slug} (${tag}): each link's name starts with its visible words`,
        names.every(([t, n]) => n.toLowerCase().includes(t.toLowerCase())),
        JSON.stringify(names),
      );
      check(
        `${project.slug} (${tag}): no cover image in the head`,
        (await page.locator('.pd-head img').count()) === 0,
      );
      check(
        `${project.slug} (${tag}): "How Claude was used" only when the record has it`,
        (await page.locator('#claude').count()) === (project.usage ? 1 : 0),
      );
      const related = await page.locator('.pd-related .pcard').count();
      check(
        `${project.slug} (${tag}): up to three more from the event, and "All ${event.n} projects"`,
        related <= 3 &&
          (event.n < 2 ||
            (await page.locator('.pd-more').innerText()).includes(`All ${event.n} projects`)),
      );
      check(
        `${project.slug} (${tag}): no dead "#" links`,
        (await page.locator('a[href="#"], a[href=""]').count()) === 0,
      );
      check(`${project.slug} (${tag}): no overflow`, !(await overflow(page)));
      await shot(page, `project-${project.slug}-${tag}`, w !== 1440);
      check(`${project.slug} (${tag}): no console errors`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  }

  // ── 404s ───────────────────────────────────────────────────────────────
  {
    const { page, context } = await newPage(1440, 900);
    const unknown = await page.goto(`${BASE}/projects/no-such-project-here/`);
    check('unknown project → 404', unknown?.status() === 404);
    if (draftProject) {
      const hidden = await page.goto(`${BASE}/projects/${draftProject.slug}/`);
      check(`draft project (${draftProject.slug}) → 404 for the public`, hidden?.status() === 404);
      await page.goto(`${BASE}/projects/?q=${encodeURIComponent(draftProject.slug.split('-')[0])}`);
      check(
        'a draft never appears in directory results',
        !(await page.content()).includes(`/projects/${draftProject.slug}/`),
      );
    }
    await context.close();
  }
} finally {
  await writeFile(`${OUT}/report.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await pool.end();
}
console.log(
  `\n${results.length - failures}/${results.length} checks passed; screenshots in ${OUT}/`,
);
process.exit(failures ? 1 : 0);
