/**
 * Visual review harness.
 *
 * Screenshots the site at the viewports the brief calls out so the design can
 * actually be looked at rather than imagined. Dev-only; not part of the build.
 *
 *   node scripts/shoot.mjs [url] [outDir]
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.argv[2] ?? 'http://localhost:4321';
const OUT = process.argv[3] ?? 'shots';

const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '430', width: 430, height: 932 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 900 },
  { name: '1440', width: 1440, height: 900 },
  { name: '1728', width: 1728, height: 1080 },
];

const PAGES = (process.env.SHOOT_PAGES ?? '/').split(',');

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

for (const path of PAGES) {
  const slug = path === '/' ? 'home' : path.replace(/\//g, '-').replace(/^-/, '');

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(BASE + path, { waitUntil: 'networkidle' });

    // Walk the page a screen at a time so every reveal observer actually
    // intersects — jumping straight to the bottom skips the middle and
    // captures sections that were never revealed.
    await page.evaluate(async () => {
      await document.fonts.ready;
      const step = window.innerHeight * 0.8;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 90));
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: `${OUT}/${slug}-${vp.name}-fold.png` });
    await page.screenshot({ path: `${OUT}/${slug}-${vp.name}-full.png`, fullPage: true });

    await context.close();
    console.log(`shot ${slug} @ ${vp.name}`);
  }
}

await browser.close();
