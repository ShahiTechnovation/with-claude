/**
 * Renders the social share card to `public/og-card.jpg`.
 *
 * The card is deliberately evergreen — no dates, no counts — so it can never
 * go stale and start advertising an event that already happened.
 *
 *   node scripts/og.mjs
 */
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const font = (p) => pathToFileURL(resolve(root, 'node_modules', p)).href;

const FRAUNCES = font('@fontsource-variable/fraunces/files/fraunces-latin-wonk-normal.woff2');
const FRAUNCES_I = font('@fontsource-variable/fraunces/files/fraunces-latin-wonk-italic.woff2');
const MONO = font('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2');

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:'F';src:url('${FRAUNCES}') format('woff2-variations');font-weight:100 900;font-style:normal}
@font-face{font-family:'F';src:url('${FRAUNCES_I}') format('woff2-variations');font-weight:100 900;font-style:italic}
@font-face{font-family:'M';src:url('${MONO}') format('woff2');font-weight:400}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#F2EEE6;color:#17150F;font-family:'F',serif;
  display:flex;flex-direction:column;justify-content:space-between;padding:62px 68px;position:relative;overflow:hidden}
.grid{position:absolute;inset:0;
  background-image:linear-gradient(to right,rgba(23,21,15,.07) 1px,transparent 1px),
                   linear-gradient(to bottom,rgba(23,21,15,.07) 1px,transparent 1px);
  background-size:96px 96px}
.slug{position:relative;display:flex;justify-content:space-between;align-items:center;
  font-family:'M',monospace;font-size:17px;letter-spacing:.18em;text-transform:uppercase;color:#6B655C;
  padding-bottom:20px;border-bottom:1px solid #D6CFC2}
.brand{display:flex;align-items:center;gap:14px;color:#17150F}
.mark{color:#D97757}
h1{position:relative;font-size:148px;line-height:.84;letter-spacing:-.04em;font-weight:600;
  font-variation-settings:'WONK' 1}
h1 em{font-style:italic;font-weight:400}
h1 .stop{color:#D97757}
.foot{position:relative;display:flex;justify-content:space-between;align-items:flex-end;
  padding-top:22px;border-top:1px solid #D6CFC2}
.tag{font-size:30px;font-weight:500;font-variation-settings:'WONK' 1;letter-spacing:-.015em}
.dom{font-family:'M',monospace;font-size:17px;letter-spacing:.16em;text-transform:uppercase;color:#A0472A}
</style>
<div class="grid"></div>
<div class="slug">
  <span class="brand">
    <svg class="mark" width="24" height="24" viewBox="0 0 24 24" fill="none">
      <g stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M12 1.5v5.2M12 17.3v5.2M1.5 12h5.2M17.3 12h5.2"/>
        <path d="M4.9 4.9l2.6 2.6M16.5 16.5l2.6 2.6M19.1 4.9l-2.6 2.6M7.5 16.5l-2.6 2.6" opacity=".55"/>
      </g><circle cx="12" cy="12" r="3.4" fill="currentColor"/>
    </svg>
    Claude India
  </span>
  <span>68°E — 95.5°E · 7°N — 34.5°N</span>
</div>
<h1>India is<br><em>building<span class="stop">.</span></em></h1>
<div class="foot">
  <span class="tag">Where India builds with Claude.</span>
  <span class="dom">claudeindia.in</span>
</div>`;

await mkdir(resolve(root, 'public'), { recursive: true });
const file = resolve(root, 'scripts', '.og.html');
await writeFile(file, html, 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
});
await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: resolve(root, 'public/og-card.jpg'), type: 'jpeg', quality: 88 });
await browser.close();
console.log('wrote public/og-card.jpg');
