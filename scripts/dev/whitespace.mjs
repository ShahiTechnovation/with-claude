/**
 * WHITESPACE — the empty vertical bands on a page, measured from the DOM.
 *
 *   BASE=http://localhost:4321 node scripts/dev/whitespace.mjs 1440 / /about/
 *
 * Prints one JSON line per path: the page height, the largest gap between
 * content, every gap over the limit (120px at widths of 900 and up, 96px
 * below) with its y, height and the nearest heading above it, and emptyPct:
 * the sum of gaps of 48px or more as a share of the page height.
 *
 * Content is every visible text-bearing element plus img, svg, canvas, video,
 * iframe, input, select, button and a[href]. Boxes are layout boxes, so a
 * line's leading and a card's padding count as empty while a card's
 * background does not; a pixel scan of a screenshot sees those differently.
 * Runs in the system Chrome with reduced motion after scrolling the page, so
 * lazy images are loaded and no reveal is left at opacity 0.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:4321';
const [width, ...paths] = process.argv.slice(2);
if (!(+width > 0) || paths.length === 0) {
  console.error('usage: BASE=<origin> node scripts/dev/whitespace.mjs <width> <path>…');
  process.exit(1);
}
const limit = +width >= 900 ? 120 : 96;

const browser = await chromium.launch({ channel: 'chrome' });
for (const path of paths) {
  const page = await browser.newPage({
    viewport: { width: +width, height: 900 },
    reducedMotion: 'reduce',
  });
  // An embed that keeps polling must not fail a page that loaded.
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const scrollH = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < scrollH; y += 600) {
    await page.evaluate((v) => scrollTo(0, v), y);
    await page.waitForTimeout(40);
  }
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const height = document.documentElement.scrollHeight;
    const media = 'img, svg, canvas, video, iframe, input, select, button, a[href]';
    const shown = (el, rect) => {
      if (rect.width < 2 || rect.height < 2) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || +cs.opacity === 0 || cs.position === 'fixed') return false;
      return !el.closest('[hidden], .visually-hidden, .skip-link, svg svg');
    };
    const boxes = [];
    const headings = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TITLE', 'TEMPLATE'].includes(el.tagName))
        continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own && !el.matches(media)) continue;
      const rect = el.getBoundingClientRect();
      if (!shown(el, rect)) continue;
      const top = rect.top + scrollY;
      const bottom = Math.min(rect.bottom + scrollY, height);
      if (bottom <= top) continue;
      boxes.push([top, bottom]);
      if (/^H[1-6]$/.test(el.tagName))
        headings.push({ bottom, text: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 60) });
    }
    return { height, boxes, headings };
  });

  // Merge the boxes into vertical intervals; the gaps are what lies between.
  r.boxes.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [t, b] of r.boxes) {
    const last = merged.at(-1);
    if (last && t <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([t, b]);
  }
  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    const y = Math.round(merged[i - 1][1]);
    const h = Math.round(merged[i][0]) - y;
    if (h > 0) gaps.push({ y, h });
  }
  const above = (y) => r.headings.filter((h) => h.bottom <= y + 1).at(-1)?.text ?? null;
  const empty = gaps.filter((g) => g.h >= 48).reduce((s, g) => s + g.h, 0);
  console.log(
    JSON.stringify({
      path,
      width: +width,
      height: r.height,
      maxGap: gaps.reduce((m, g) => Math.max(m, g.h), 0),
      gapsOver: gaps.filter((g) => g.h > limit).map((g) => ({ ...g, heading: above(g.y) })),
      emptyPct: +((100 * empty) / r.height).toFixed(1),
    }),
  );
  await page.close();
}
await browser.close();
