import { chromium } from 'playwright';
const b = await chromium.launch();
for (const [w, h, tag] of [[1440, 1100, 'desktop'], [820, 1100, 'tablet'], [390, 900, 'mobile']]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.goto('http://localhost:4321/events', { waitUntil: 'networkidle' });
  const over = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  const clipped = await p.evaluate(() =>
    [...document.querySelectorAll('.lead-name, .past-name, .next-name, .past-venue, .figure dd')]
      .filter((e) => e.scrollWidth > e.clientWidth + 2).length,
  );
  await p.screenshot({ path: `shots/events-${tag}.png`, fullPage: tag === 'mobile' });
  console.log(`${tag.padEnd(8)} ${w}px  h-overflow=${over}  clipped-text=${clipped}`);
  await p.close();
}
await b.close();
