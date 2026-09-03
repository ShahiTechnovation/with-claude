import { chromium } from 'playwright';
const b = await chromium.launch();
const c = await b.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const p = await c.newPage();
await p.goto('http://localhost:4321/', { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
const hidden = await p.evaluate(
  () =>
    [...document.querySelectorAll('[data-reveal]')].filter(
      (el) => Number(getComputedStyle(el).opacity) < 0.9,
    ).length,
);
const meridian = await p.evaluate(() => {
  const m = document.querySelector('.meridian');
  return m ? getComputedStyle(m, '::after').transform : 'none';
});
console.log('hidden reveals under reduced-motion:', hidden);
console.log('meridian transform:', meridian);
await p.screenshot({ path: 'shots/home-reduced-fold.png' });
await p.screenshot({ path: 'shots/home-reduced-full.png', fullPage: true });
await b.close();
