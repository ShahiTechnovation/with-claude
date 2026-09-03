import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:4321';
const OUT = 'shots4';
const PAGES = [
  '/',
  '/events',
  '/events/claude-conversation-september',
  '/cities',
  '/cities/bhopal',
  '/cities/kochi',
  '/builders',
  '/builders/aniket-sahu',
  '/projects',
  '/stories',
  '/community',
  '/404',
];
await mkdir(OUT, { recursive: true });
const b = await chromium.launch();
for (const path of PAGES) {
  const slug = path === '/' ? 'home' : path.replace(/^\//, '').replace(/\//g, '-');
  for (const [name, w, h] of [
    ['d', 1440, 900],
    ['m', 390, 844],
  ]) {
    const c = await b.newContext({ viewport: { width: w, height: h } });
    const p = await c.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    const res = await p.goto(BASE + path, { waitUntil: 'networkidle' });
    await p.evaluate(async () => {
      await document.fonts.ready;
      const step = window.innerHeight * 0.8;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((r) => setTimeout(r, 80));
      }
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/${slug}-${name}.png`, fullPage: true });
    if (errs.length) console.log(`  !! ${path} [${name}] ${errs.join(' | ')}`);
    console.log(`${res.status()} ${path} @${name}`);
    await c.close();
  }
}
await b.close();
