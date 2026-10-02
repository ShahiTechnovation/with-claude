#!/usr/bin/env node
/**
 * PROJECT DIRECTORY — browser journey and screenshots, against a local dev
 * server on a rehearsal database (scripts/dev/rehearse-event-archive.sh).
 *
 *   BASE=http://127.0.0.1:4321 DATABASE_URL=postgresql://…@127.0.0.1:…/withclaude_directory \
 *     OUT=shots/directory node scripts/dev/directory-journey.mjs
 *
 * Checks what a screenshot cannot: real filter/search/sort/pagination
 * behaviour, URL state, back/forward, the drawer's focus handling, the no-JS
 * form, 404s, the logo fallbacks (with intercepted test images, never a real
 * participant site), console errors and horizontal overflow. Exits non-zero
 * on any failure. Writes PNGs and report.json to OUT.
 *
 * It temporarily points two projects' logos at test images and restores them.
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { deflateSync } from 'node:zlib';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4321';
const OUT = process.env.OUT ?? 'shots/directory';
const DB = process.env.DATABASE_URL ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE) || !/@(127\.0\.0\.1|localhost)[:/]/.test(DB)) {
  console.error('directory-journey.mjs only runs against a loopback app and a loopback database.');
  process.exit(1);
}
await mkdir(OUT, { recursive: true });
const pool = new pg.Pool({ connectionString: DB });
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const results = [];
let failures = 0;
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failures += 1;
};

// ── fixtures for the logo cases (restored at the end) ─────────────────────
/** A tiny valid PNG with a centred mark on transparency, built without dependencies. */
function solidPng(w, h, [r, g, b, a]) {
  const crc = (buf) => {
    let c, crcTable = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let x = 0xffffffff;
    for (const byte of buf) x = crcTable[(x ^ byte) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      // a centred dark mark on transparency, so "transparent logo" is visible
      const inside = Math.abs(x - w / 2) < w * 0.32 && Math.abs(y - h / 2) < h * 0.32;
      raw[o] = inside ? r : 0;
      raw[o + 1] = inside ? g : 0;
      raw[o + 2] = inside ? b : 0;
      raw[o + 3] = inside ? a : 0;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TEST_IMAGES = {
  'https://logos.test/wide.png': solidPng(320, 80, [22, 20, 14, 255]),
  'https://logos.test/transparent.png': solidPng(200, 200, [158, 69, 38, 255]),
};

const pick = async (sql, params = []) => (await pool.query(sql, params)).rows;
const [wideProject] = await pick(`select id, slug from projects where publication_status='published' and content_authority='baserow' and slug like 'compute%' limit 1`);
const [clearProject] = await pick(`select id, slug from projects where publication_status='published' and content_authority='baserow' and slug like 'strata%' limit 1`);
const [brokenProject] = await pick(`select id, slug from projects where publication_status='published' and content_authority='baserow' and slug like 'fly-invaders%' limit 1`);
const [draftProject] = await pick(`select slug from projects where publication_status='draft' and content_authority='baserow' limit 1`);
// What the directory must show, from the same public predicate the site uses
// (published, clean moderation, not deleted) — never a constant from an
// earlier rehearsal, so held drafts and moderator holds are accounted for.
const publicCount = async (...eventSlugs) =>
  (
    await pick(
      `select count(*)::int n from projects p join events e on e.id=p.built_at_event_id where p.publication_status='published' and p.moderation_state='clean' and p.deleted_at is null and e.slug = any($1)`,
      [eventSlugs],
    )
  )[0].n;
const IL = await publicCount('claude-impact-lab-september');
const FB = await publicCount('bhopal-claude-code-build-day-fable-5-1');
const BOTH = IL + FB;
/** "… of 76 projects" says 76, not 176. */
const saysCount = (text, n) => new RegExp(`(^|\\D)${n} projects`).test(text);
console.log(`expected public: Impact Lab 2 ${IL}, Fable 5.1 ${FB}, both ${BOTH}`);
const mediaIds = [];
async function attachLogo(project, url) {
  const [m] = await pick(
    `insert into media (blob_url, alt, status, kind, provenance, width, height) values ($1, 'test logo', 'published', 'logo', 'upload', 256, 256) returning id`,
    [url],
  );
  mediaIds.push(m.id);
  await pool.query('update projects set logo_media_id = $1 where id = $2', [m.id, project.id]);
}
await attachLogo(wideProject, 'https://logos.test/wide.png');
await attachLogo(clearProject, 'https://logos.test/transparent.png');
await attachLogo(brokenProject, 'https://logos.test/missing.png');

async function newPage(width, height, { js = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled: js });
  const page = await context.newPage();
  const errors = [];
  const brokenHits = [];
  page.on('console', (m) => m.type() === 'error' && !/privy|Failed to load resource|dev-toolbar/i.test(m.text()) && errors.push(m.text().slice(0, 200)));
  // Astro's dev toolbar is dev-server-only chrome; production builds are checked separately.
  page.on('pageerror', (e) => !/dev-toolbar/.test(e.message) && errors.push(`pageerror: ${e.message.slice(0, 200)}`));
  await context.route('https://logos.test/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('missing.png')) {
      brokenHits.push(url);
      return route.fulfill({ status: 404, body: 'not found' });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: TEST_IMAGES[url] });
  });
  return { page, context, errors, brokenHits };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
const shot = (page, name, full = false) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
const rows = (page) => page.locator('.dir-list > li .prow');
const countText = (page) => page.locator('[data-dir-count]').innerText();

try {
  // ── desktop directory ───────────────────────────────────────────────────
  {
    const { page, context, errors } = await newPage(1440, 900);
    const res = await page.goto(`${BASE}/projects/`, { waitUntil: 'load', timeout: 90_000 });
    check('directory answers 200', res?.status() === 200);
    // document.querySelectorAll, not a Playwright locator: locators pierce the
    // dev toolbar's shadow DOM (dev only), which has headings of its own.
    const h1s = await page.evaluate(() => [...document.querySelectorAll('h1')].map((h) => h.innerText.trim()));
    check('one h1 reading "Project Directory"', h1s.join('|') === 'Project Directory', h1s.join('|'));
    check('60 rows on the first page (the largest bounded page)', (await rows(page).count()) === 60);
    const badges = await page.locator('.dir-list .badge-event').allInnerTexts();
    check('every row on page 1 has a "Built at" badge with a date', badges.length === 60 && badges.every((b) => /^Built at .+ · \d{1,2} \w{3} 2026$/.test(b.trim())), badges.slice(0, 3).join(' / '));
    check('default sort is newest event first (Fable 5.1 first)', badges[0]?.includes('Fable 5.1 Build Day · 20 Sep 2026'), badges[0]);
    check('sidebar visible beside results', await page.locator('#dir-filters').isVisible());
    check('search field and first result above the fold', await page.evaluate(() => {
      const s = document.querySelector('[data-dir-q]').getBoundingClientRect();
      const r = document.querySelector('.dir-list .prow').getBoundingClientRect();
      return s.top < innerHeight && r.top < innerHeight;
    }));
    check('no horizontal overflow at 1440', !(await overflow(page)));
    await shot(page, 'directory-1440');
    await shot(page, 'directory-1440-full', true);

    // Event filter.
    await page.locator('input[data-facet="events:claude-impact-lab-september"]').check();
    await page.waitForURL(/event=claude-impact-lab-september/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    const ilBadges = await page.locator('.dir-list .badge-event').allInnerTexts();
    check(`Impact Lab 2 filter: ${IL} projects`, saysCount(await countText(page), IL), await countText(page));
    check('Impact Lab 2 filter: every badge says Impact Lab 2 · 15 Sep 2026', ilBadges.length === Math.min(IL, 20) && ilBadges.every((b) => b.includes('Impact Lab 2 · 15 Sep 2026')), ilBadges[0]);
    check('no badge anywhere says 13 Sep', !(await page.content()).includes('13 Sep 2026'));
    check('the "All events" option is not current when an event is chosen', (await page.locator('[data-all-events]').getAttribute('aria-current')) === null);
    // OR within the group.
    await page.locator('input[data-facet="events:bhopal-claude-code-build-day-fable-5-1"]').check();
    await page.waitForURL(/event=bhopal-claude-code-build-day-fable-5-1/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    check(`two events (OR): ${BOTH} projects`, saysCount(await countText(page), BOTH), await countText(page));
    // AND across groups.
    await page.locator('input[data-facet="has:video"]').check();
    await page.waitForURL(/has=video/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    const withVideo = await countText(page);
    const [{ n: expectVideo }] = await pick(
      `select count(*)::int n from projects p join events e on e.id=p.built_at_event_id where p.publication_status='published' and p.moderation_state='clean' and p.deleted_at is null and p.video_url is not null and e.slug in ('claude-impact-lab-september','bhopal-claude-code-build-day-fable-5-1')`,
    );
    check(`events AND "has demo video": ${expectVideo} projects (matches SQL)`, withVideo.includes(String(expectVideo)), withVideo);
    check('active-filter chips shown with Clear all', (await page.locator('.dir-chips .dir-chip').count()) === 3 && (await page.locator('.dir-clear', { hasText: 'Clear all' }).count()) === 1);
    await shot(page, 'directory-1440-filters-active');
    // Remove one chip.
    await page.locator('.dir-chips .dir-chip', { hasText: 'Has demo video' }).click();
    await page.waitForURL((u) => !u.search.includes('has=video'));
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    check('removing a chip removes only that filter', saysCount(await countText(page), BOTH) && !(await page.locator('input[data-facet="has:video"]').isChecked()));
    // Back / forward.
    await page.goBack();
    await page.waitForURL(/has=video/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    check('back restores the previous filters and results', (await page.locator('input[data-facet="has:video"]').isChecked()) && (await countText(page)).includes(String(expectVideo)));
    await page.goForward();
    await page.waitForURL((u) => !u.search.includes('has=video'));
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    check('forward re-applies the later state', !(await page.locator('input[data-facet="has:video"]').isChecked()));
    // Clear all.
    await page.locator('.dir-clear', { hasText: 'Clear all' }).click();
    await page.waitForURL(`${BASE}/projects/`);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    check('clear all returns the whole directory', (await page.locator('.dir-chips').count()) === 0);

    // Search (debounced, replaceState).
    await page.locator('[data-dir-q]').fill('traffic');
    await page.waitForURL(/q=traffic/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    const titles = await page.locator('.prow-title').allInnerTexts();
    // Held rows (Fable 31/80, BhopalFlow AI and BHOPAL//FLOW, wait on a
    // duplicate decision) are drafts: whichever drafts match, search must not
    // surface them. Read from the database so a stale copy cannot pass or fail
    // this by accident.
    const [{ n: trafficPublic }] = await pick(
      `select count(*)::int n from projects where publication_status='published' and moderation_state='clean' and deleted_at is null and (title ilike '%traffic%' or summary ilike '%traffic%')`,
    );
    const trafficDrafts = (await pick(
      `select title from projects where publication_status<>'published' and deleted_at is null and (title ilike '%traffic%' or summary ilike '%traffic%' or title ilike '%bhopal%flow%')`,
    )).map((r) => r.title);
    check(`search "traffic" never shows a draft (${trafficDrafts.join(', ') || 'none in this database'})`, trafficDrafts.every((t) => !titles.includes(t)), titles.join(', '));
    check(`search "traffic" returns results only when a public project matches (${trafficPublic} by title/summary)`, trafficPublic === 0 || titles.length > 0, titles.join(', '));
    check('search keeps focus in the field', await page.evaluate(() => document.activeElement?.matches('[data-dir-q]')));
    await page.locator('[data-dir-q]').fill('Matmulattention');
    await page.waitForURL(/q=Matmulattention/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    check('search matches a team label', (await page.locator('.prow-title').allInnerTexts()).includes('Disha'));
    await page.locator('[data-dir-q]').fill('zz-no-such-project');
    await page.waitForURL(/q=zz-no-such-project/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    check('no-results state is distinct', (await page.locator('.dir-empty h2').innerText()).includes('No projects match these filters'));
    await page.locator('[data-dir-q]').fill('');
    await page.waitForURL(`${BASE}/projects/`);

    // Sort + pagination.
    await page.locator('[data-dir-sort]').selectOption('name');
    await page.waitForURL(/sort=name/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    const sorted = await page.locator('.prow-title').allInnerTexts();
    // The server orders lower(title) by byte (COLLATE "C"): compare the same way.
    const outOfOrder = sorted.findIndex((t, i) => i > 0 && Buffer.from(sorted[i - 1].toLowerCase()).compare(Buffer.from(t.toLowerCase())) > 0);
    check('Name A–Z is alphabetical (case-insensitive)', outOfOrder === -1, outOfOrder > 0 ? `${sorted[outOfOrder - 1]} > ${sorted[outOfOrder]}` : '');
    await page.locator('.dir-pager a', { hasText: '2' }).first().click();
    await page.waitForURL(/page=2/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    const page2 = await page.locator('.prow-title').allInnerTexts();
    check('page 2 keeps the sort and shows the rest', /sort=name/.test(page.url()) && page2.length > 0 && page2.length <= 60 && !page2.includes(sorted[0]));
    check('current page is marked', (await page.locator('.dir-pager [aria-current="page"]').innerText()).includes('2'));
    // Into a project and back: filters/sort preserved.
    await page.locator('.prow-link').first().click();
    await page.waitForURL(/\/projects\/[a-z0-9-]+\/$/);
    await page.goBack();
    await page.waitForURL(/page=2/);
    check('returning from a project keeps sort and page', /sort=name/.test(page.url()) && (await page.locator('[data-dir-sort]').inputValue()) === 'name');
    check('no console errors on the directory (desktop)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ── tablet ──────────────────────────────────────────────────────────────
  {
    const { page, context, errors } = await newPage(768, 1024);
    await page.goto(`${BASE}/projects/`, { waitUntil: 'load', timeout: 90_000 });
    check('768: filters collapse behind a button', (await page.locator('[data-open-filters]').isVisible()) && !(await page.locator('#dir-filters').isVisible()));
    check('768: no horizontal overflow', !(await overflow(page)));
    await shot(page, 'directory-768');
    await page.locator('[data-open-filters]').click();
    await page.waitForTimeout(400);
    await shot(page, 'directory-768-drawer');
    check('no console errors (768)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ── mobile ──────────────────────────────────────────────────────────────
  {
    const { page, context, errors } = await newPage(375, 812);
    await page.goto(`${BASE}/projects/`, { waitUntil: 'load', timeout: 90_000 });
    check('375: no horizontal overflow', !(await overflow(page)));
    const firstBadge = page.locator('.dir-list .badge-event').first();
    const box = await firstBadge.boundingBox();
    check('375: the event name and date are fully visible in the row', Boolean(box && box.x >= 0 && box.x + box.width <= 375) && /Fable 5\.1 Build Day · 20 Sep 2026/.test(await firstBadge.innerText()));
    await shot(page, 'directory-375');
    await shot(page, 'directory-375-full', true);
    const toggle = page.locator('[data-open-filters]');
    await toggle.click();
    await page.waitForSelector('#dir-filters.is-open');
    await page.waitForTimeout(350);
    check('drawer opens as a modal dialog', (await page.locator('#dir-filters').getAttribute('role')) === 'dialog' && (await page.locator('#dir-filters').getAttribute('aria-modal')) === 'true');
    check('focus moves into the drawer', await page.evaluate(() => document.getElementById('dir-filters').contains(document.activeElement)));
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    check('focus stays inside the drawer', await page.evaluate(() => document.getElementById('dir-filters').contains(document.activeElement)));
    await shot(page, 'directory-375-drawer');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    check('Escape closes the drawer and returns focus to "Filters"', !(await page.locator('#dir-filters.is-open').count()) && (await page.evaluate(() => document.activeElement?.matches('[data-open-filters]'))));
    // Choose in the drawer, then Apply.
    await toggle.click();
    await page.waitForSelector('#dir-filters.is-open');
    await page.locator('input[data-facet="events:claude-impact-lab-september"]').check();
    check('the drawer does not apply until Apply', !page.url().includes('event='));
    await page.locator('[data-apply]').click();
    await page.waitForURL(/event=claude-impact-lab-september/);
    await page.waitForFunction(() => !document.querySelector('[data-dir-swap]')?.hasAttribute('aria-busy'));
    check('Apply filters and closes the drawer', saysCount(await countText(page), IL) && !(await page.locator('#dir-filters.is-open').count()));
    check('"Filters (1)" shows the active count', /Filters \(1\)/.test(await page.locator('[data-open-filters]').innerText()));
    await shot(page, 'directory-375-filtered');
    check('no console errors (375)', errors.length === 0, errors.join(' | '));
    await context.close();
  }

  // ── without JavaScript ──────────────────────────────────────────────────
  {
    const { page, context } = await newPage(1440, 900, { js: false });
    await page.goto(`${BASE}/projects/`);
    await page.locator('input[data-facet="categories:agent"]').check();
    await page.locator('[data-apply]').click();
    await page.waitForURL(/category=agent/);
    const n = await rows(page).count();
    const [{ n: agents }] = await pick(`select count(*)::int n from projects where publication_status='published' and moderation_state='clean' and deleted_at is null and category='agent'`);
    check(`no-JS: the form applies filters by GET (${agents} agents)`, n === Math.min(20, agents), String(n));
    await page.goto(`${BASE}/projects/?page=2`);
    check('no-JS: pagination links work', (await rows(page).count()) > 0);
    await context.close();
  }

  // ── project pages, one per event, plus fallbacks ────────────────────────
  const detail = async (slug, width, height, name) => {
    const { page, context, errors, brokenHits } = await newPage(width, height);
    const res = await page.goto(`${BASE}/projects/${slug}/`, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForTimeout(300);
    if (name) await shot(page, name, width !== 1440);
    return { page, context, errors, brokenHits, res };
  };
  const [il] = await pick(`select p.slug from projects p join events e on e.id=p.built_at_event_id where e.slug='claude-impact-lab-september' and p.publication_status='published' and p.slug like 'disha%'`);
  const [fb] = await pick(`select p.slug from projects p join events e on e.id=p.built_at_event_id where e.slug='bhopal-claude-code-build-day-fable-5-1' and p.publication_status='published' and p.slug like 'incidentos%'`);
  for (const [slug, label, date, longDate] of [
    [il.slug, 'Impact Lab 2', '15 Sep 2026', '15 September 2026'],
    [fb.slug, 'Fable 5.1 Build Day', '20 Sep 2026', '20 September 2026'],
  ]) {
    for (const [w, h, tag] of [[1440, 900, '1440'], [375, 812, '375']]) {
      const { page, context, errors, res } = await detail(slug, w, h, `project-${slug}-${tag}`);
      check(`${slug} (${tag}): 200`, res?.status() === 200);
      check(`${slug} (${tag}): header badge "Built at ${label} · ${date}"`, (await page.locator('.pd-head .badge-event').innerText()).includes(`${label} · ${date}`));
      check(`${slug} (${tag}): facts card event date ${longDate} and city Bhopal`, (await page.locator('.facts-list').innerText()).includes(longDate) && (await page.locator('.facts-list').innerText()).includes('Bhopal'));
      const crumbs = (await page.locator('nav[aria-label="Breadcrumb"] li').allInnerTexts()).map((t) => t.replace(/[\s/]+$/g, '').trim().toLowerCase());
      check(`${slug} (${tag}): breadcrumbs Home → Projects → title`, crumbs.length === 3 && crumbs[0] === 'home' && crumbs[1] === 'projects', crumbs.join(' | '));
      check(`${slug} (${tag}): no dead "#" links`, (await page.locator('a[href="#"], a[href=""]').count()) === 0);
      check(`${slug} (${tag}): no overflow`, !(await overflow(page)));
      if (tag === '375') {
        const facts = await page.locator('.pd-side').boundingBox();
        const narrative = await page.locator('.pd-main').boundingBox();
        check(`${slug} (375): facts come before the narrative`, Boolean(facts && narrative && facts.y < narrative.y));
      }
      check(`${slug} (${tag}): no console errors`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  }
  {
    const { page, context } = await detail(fb.slug, 1440, 900);
    const usage = await page.locator('#claude').innerText();
    check('IncidentOS: "How Claude was used" quotes the submission', /Claude/.test(usage) && !/Not documented/.test(usage));
    check('IncidentOS: markdown bullets become a list, not asterisks', (await page.locator('#solution ul li').count()) > 3 && !(await page.locator('#solution').innerText()).includes('**'));
    await context.close();
  }
  {
    const [noUsage] = await pick(`select slug from projects where publication_status='published' and moderation_state='clean' and claude_usage is null and slug like 'sortx%'`);
    const { page, context } = await detail(noUsage.slug, 1440, 900);
    check('SortX: no Claude usage stated → "Not documented in the submission"', (await page.locator('#claude').innerText()).includes('Not documented in the submission'));
    check('SortX: placeholder logo is labelled as directory artwork', (await page.locator('.pd-head .plogo [role="img"]').getAttribute('aria-label')).includes('Placeholder artwork'));
    await shot(page, 'project-placeholder-logo-1440');
    await context.close();
  }
  {
    const { page, context, brokenHits } = await detail(brokenProject.slug, 1440, 900, 'project-broken-logo-1440');
    await page.waitForTimeout(800);
    const state = await page.evaluate(() => {
      const img = document.querySelector('.pd-head .plogo img');
      const art = document.querySelector('.pd-head .plogo .plogo-art');
      const box = document.querySelector('.pd-head .plogo').getBoundingClientRect();
      const artBox = art?.getBoundingClientRect();
      return {
        imgHidden: Boolean(img?.hidden) && getComputedStyle(img).display === 'none',
        // the mascot is actually rendered, inside the box, filling it
        artShown: Boolean(art && !art.hidden && artBox && artBox.width > 0 && Math.abs(artBox.top - box.top) < 2),
        w: box.width,
      };
    });
    check('broken logo: swapped once for the visible placeholder, box size unchanged (96px)', state.imgHidden && state.artShown && Math.round(state.w) === 96, JSON.stringify(state));
    check(`broken logo: requested at most once per image element (no retry loop: ${brokenHits.length} hits for 2 boxes)`, brokenHits.length <= 2, String(brokenHits.length));
    await context.close();
  }
  {
    const { page, context } = await newPage(1440, 900);
    await page.goto(`${BASE}/projects/?q=${encodeURIComponent('Compute Atlas')}`, { waitUntil: 'load', timeout: 90_000 });
    await page.goto(`${BASE}/projects/?event=bhopal-claude-code-build-day-fable-5-1&sort=name`, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForTimeout(500);
    const logos = await page.evaluate(() =>
      [...document.querySelectorAll('.prow')].map((r) => ({
        title: r.querySelector('.prow-title').textContent.trim(),
        w: r.querySelector('.plogo').getBoundingClientRect().width,
        h: r.querySelector('.plogo').getBoundingClientRect().height,
      })),
    );
    check('every row has a fixed square logo box (76px at desktop)', logos.length > 0 && logos.every((l) => l.w === 76 && l.h === 76), JSON.stringify(logos.find((l) => l.w !== 76)));
    await shot(page, 'directory-1440-logos-wide-transparent');
    await context.close();
  }
  {
    const { page, context } = await detail(wideProject.slug, 1440, 900, 'project-wide-logo-1440');
    const fit = await page.evaluate(() => getComputedStyle(document.querySelector('.pd-head .plogo img')).objectFit);
    check('wide logo is contained, not cropped', fit === 'contain', fit);
    await context.close();
  }

  // ── event pages ─────────────────────────────────────────────────────────
  for (const [slug, count, needle, tag] of [
    ['claude-impact-lab-september', IL, 'rescheduled from 13 September', 'impact-lab-2'],
    ['bhopal-claude-code-build-day-fable-5-1', FB, null, 'fable'],
  ]) {
    for (const [w, h, size] of [[1440, 900, '1440'], [375, 812, '375']]) {
      const { page, context, errors } = await newPage(w, h);
      const res = await page.goto(`${BASE}/events/${slug}/`, { waitUntil: 'load', timeout: 90_000 });
      check(`event ${tag} (${size}): 200`, res?.status() === 200);
      const heading = await page.locator('#projects-heading').innerText();
      check(`event ${tag} (${size}): "Projects built here ${count}" — same count as the directory`, heading.includes(String(count)), heading);
      if (needle) check(`event ${tag} (${size}): says held on 15 September, ${needle}`, (await page.content()).includes(needle) && (await page.locator('.detail-rescheduled').innerText()).includes('15 September 2026'));
      check(`event ${tag} (${size}): no overflow`, !(await overflow(page)));
      await shot(page, `event-${tag}-${size}`, true);
      check(`event ${tag} (${size}): no console errors`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  }

  // ── 404s ────────────────────────────────────────────────────────────────
  {
    const { page, context } = await newPage(1440, 900);
    const unknown = await page.goto(`${BASE}/projects/no-such-project-here/`);
    check('unknown project → 404', unknown?.status() === 404);
    const hidden = await page.goto(`${BASE}/projects/${draftProject.slug}/`);
    check(`draft project (${draftProject.slug}) → 404 for the public`, hidden?.status() === 404);
    await page.goto(`${BASE}/projects/?q=${encodeURIComponent(draftProject.slug.split('-')[0])}`);
    check('a draft never appears in directory results', !(await page.content()).includes(`/projects/${draftProject.slug}/`));
    await context.close();
  }
} finally {
  await pool.query('update projects set logo_media_id = null where logo_media_id = any($1::uuid[])', [mediaIds]);
  await pool.query('delete from media where id = any($1::uuid[])', [mediaIds]);
  await writeFile(`${OUT}/report.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await pool.end();
}
console.log(`\n${results.length - failures}/${results.length} checks passed; screenshots in ${OUT}/`);
process.exit(failures ? 1 : 0);
