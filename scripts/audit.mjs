/**
 * Structural audit across every route: heading order, landmarks, alt text,
 * link text, touch targets, horizontal overflow, and a no-JS render check.
 *
 *   node scripts/audit.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:4321';
const PAGES = [
  '/',
  '/events',
  '/events/claude-conversation-september',
  '/events/claude-code-impact-lab',
  '/cities',
  '/cities/bhopal',
  '/cities/kochi',
  '/builders',
  '/builders/aniket-sahu',
  '/projects',
  '/stories',
  '/community',
  '/join',
  '/404',
];

const problems = [];
const note = (page, msg) => problems.push(`${page}: ${msg}`);

const browser = await chromium.launch();

// --- With JavaScript -------------------------------------------------------
for (const path of PAGES) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE + path, { waitUntil: 'networkidle' });

  const result = await page.evaluate(() => {
    const out = { headings: [], issues: [] };

    // Heading order
    document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
      out.headings.push({ level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 40) });
    });

    // Landmarks
    if (document.querySelectorAll('main').length !== 1)
      out.issues.push('expected exactly one <main>');
    if (!document.querySelector('footer')) out.issues.push('no <footer>');
    if (!document.querySelector('header')) out.issues.push('no <header>');

    // Images
    document.querySelectorAll('img').forEach((img) => {
      if (!img.hasAttribute('alt'))
        out.issues.push(`img without alt: ${img.currentSrc || img.src}`);
      if (!img.width || !img.height) out.issues.push(`img without dimensions: ${img.src}`);
    });

    // Links and buttons need a name
    document.querySelectorAll('a').forEach((a) => {
      const imgAlt = [...a.querySelectorAll('img')]
        .map((img) => img.getAttribute('alt') || '')
        .join(' ')
        .trim();
      const name = (a.textContent || '').trim() || a.getAttribute('aria-label') || imgAlt;
      if (!name) out.issues.push(`link without accessible name: ${a.getAttribute('href')}`);
      if (!a.getAttribute('href')) out.issues.push('anchor without href');
    });
    document.querySelectorAll('button').forEach((b) => {
      const name = (b.textContent || '').trim() || b.getAttribute('aria-label') || '';
      if (!name) out.issues.push('button without accessible name');
    });

    // External links should not leak the referrer opener
    document.querySelectorAll('a[target="_blank"]').forEach((a) => {
      if (!(a.rel || '').includes('noopener'))
        out.issues.push(`target=_blank without noopener: ${a.href}`);
    });

    // Horizontal overflow
    if (document.documentElement.scrollWidth > window.innerWidth + 1) {
      out.issues.push(`horizontal overflow: ${document.documentElement.scrollWidth}px`);
    }

    // Duplicate ids
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) out.issues.push(`duplicate ids: ${[...new Set(dupes)].join(', ')}`);

    // Title + description
    if (!document.title) out.issues.push('no <title>');
    if (!document.querySelector('meta[name="description"]')) out.issues.push('no meta description');
    if (!document.querySelector('link[rel="canonical"]')) out.issues.push('no canonical');

    return out;
  });

  // Exactly one h1, and no skipped levels
  const h1s = result.headings.filter((h) => h.level === 1);
  if (h1s.length !== 1) note(path, `expected 1 <h1>, found ${h1s.length}`);
  let prev = 0;
  for (const h of result.headings) {
    if (prev && h.level > prev + 1) note(path, `heading jumps h${prev}→h${h.level} at "${h.text}"`);
    prev = h.level;
  }
  result.issues.forEach((i) => note(path, i));

  // Focus must be visible on the first interactive element
  await page.keyboard.press('Tab');
  const focusRing = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'nothing focused';
    const s = getComputedStyle(el);
    return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
      ? null
      : `no outline on ${el.tagName}`;
  });
  if (focusRing) note(path, `focus: ${focusRing}`);

  await context.close();
}

// --- Touch targets at phone width -----------------------------------------
{
  // hasTouch makes `pointer: coarse` match, which is what gates the expanded
  // hit areas — without it this measures the wrong thing entirely.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  for (const path of ['/', '/events', '/cities', '/community', '/builders']) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    const small = await page.evaluate(() => {
      const bad = [];
      /** Probe the real hit area, which may come from a pseudo-element. */
      const hits = (el, x, y) => {
        const found = document.elementFromPoint(x, y);
        return Boolean(found && (found === el || el.contains(found) || found.contains(el)));
      };

      document.querySelectorAll('a, button, summary').forEach((el) => {
        // The plate's SVG nodes are non-interactive at this width by design.
        if (el.closest('svg')) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (r.top < 0 || r.bottom > window.innerHeight) return; // offscreen: skip

        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // Skip anything not actually hit-testable: closed drawers, covered
        // elements. If its own centre does not reach it, it is not on screen.
        if (getComputedStyle(el).visibility === 'hidden') return;
        if (!hits(el, cx, cy)) return;

        const reach = hits(el, cx, cy - 15) && hits(el, cx, cy + 15);
        if (!reach) {
          bad.push(
            `${el.tagName}.${el.className.toString().split(' ')[0] || '(none)'} ${Math.round(r.height)}px`,
          );
        }
      });
      return [...new Set(bad)];
    });
    small.forEach((s) => note(`${path} @390`, `touch target under 30px: ${s}`));
  }
  await context.close();
}

// --- Without JavaScript ----------------------------------------------------
{
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  for (const path of ['/', '/cities', '/events']) {
    await page.goto(BASE + path, { waitUntil: 'load' });
    const state = await page.evaluate(() => {
      const readout = document.querySelector('[data-readout-name]');
      const hidden = [...document.querySelectorAll('[data-reveal]')].filter((el) => {
        const s = getComputedStyle(el);
        return Number(s.opacity) < 0.9;
      }).length;
      return {
        readout: readout ? readout.textContent.trim() : 'n/a',
        hiddenReveals: hidden,
        bodyText: document.body.innerText.length,
      };
    });
    if (state.hiddenReveals > 0)
      note(`${path} (no JS)`, `${state.hiddenReveals} elements still hidden`);
    if (state.bodyText < 800)
      note(`${path} (no JS)`, `only ${state.bodyText} chars of text rendered`);
    if (state.readout !== 'n/a' && !state.readout) note(`${path} (no JS)`, 'map readout is empty');
  }
  await context.close();
}

await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} issue(s):\n`);
  problems.forEach((p) => console.log('  · ' + p));
  process.exitCode = 1;
} else {
  console.log(
    '\nClean: headings, landmarks, alt text, link names, overflow, focus, touch targets, no-JS.',
  );
}
