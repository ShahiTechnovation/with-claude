/**
 * TYPE CENSUS — the rendered size of every visible piece of text on a page.
 *
 *   BASE=http://localhost:4321 node scripts/dev/type-census.mjs 390 / /projects/ /events/
 *
 * Prints one JSON line per path: the page height, the visible text elements,
 * how many are under 15px, tracked uppercase or monospace, and the distinct
 * sizes. Sizes are multiplied by the page zoom, so `html { zoom: 0.8 }` is
 * counted as the reader sees it. Runs in the system Chrome with reduced
 * motion, so a scroll reveal never leaves text at opacity 0.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:4321';
const [width, ...paths] = process.argv.slice(2);
if (!(+width > 0) || paths.length === 0) {
  console.error('usage: BASE=<origin> node scripts/dev/type-census.mjs <width> <path>…');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome' });
for (const path of paths) {
  const page = await browser.newPage({
    viewport: { width: +width, height: 900 },
    reducedMotion: 'reduce',
  });
  // An embed that keeps polling must not fail a page that loaded.
  await page.goto(BASE + path, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 600) {
    await page.evaluate((v) => scrollTo(0, v), y);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => {
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom || '1') || 1;
    const out = { zoom, els: 0, lt15: 0, caps: 0, mono: 0, sizes: {} };
    for (const el of document.body.querySelectorAll('*')) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION', 'TITLE'].includes(el.tagName)) continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (
        cs.visibility === 'hidden' ||
        cs.display === 'none' ||
        rect.width < 2 ||
        rect.height < 2 ||
        +cs.opacity === 0
      )
        continue;
      if (el.closest('[hidden], details:not([open]) > :not(summary), .visually-hidden, .skip-link'))
        continue;
      const fs = parseFloat(cs.fontSize) * zoom;
      out.els++;
      if (fs < 15) out.lt15++;
      if (cs.textTransform === 'uppercase' && parseFloat(cs.letterSpacing) > 0.3) out.caps++;
      if (/mono/i.test(cs.fontFamily.split(',')[0])) out.mono++;
      const k = Math.round(fs);
      out.sizes[k] = (out.sizes[k] || 0) + 1;
    }
    return out;
  });
  const sizes = Object.keys(r.sizes)
    .map(Number)
    .sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      path,
      width: +width,
      zoom: r.zoom,
      height,
      text: r.els,
      under15: r.lt15,
      trackedCaps: r.caps,
      mono: r.mono,
      sizes: sizes.length,
      sizeList: sizes,
    }),
  );
  await page.close();
}
await browser.close();
