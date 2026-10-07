/**
 * The picture a link unfurler gets for an event page.
 *
 * Eight of seventeen event pages advertised an `og:image` that returned 404,
 * for as long as the pages have existed. The page passed `event.coverImage` —
 * a data-layer KEY like `covers/cover-vol01.jpg`, resolved against
 * `src/assets/` — straight to the layout, which turned it into
 * `https://www.withclaude.in/covers/cover-vol01.jpg`. The site has never
 * served that path. The nine events with no cover fell back to the layout's
 * `/og-card.jpg`, a real file in `public/`, and worked. So the events WITH a
 * cover shared worse than the events without one.
 *
 * WHY THESE TESTS LOOK THE WAY THEY DO. A test asserting the string in the
 * meta tag would have passed happily the entire time the site was broken —
 * `image={event.coverImage}` puts a perfectly well-formed string in the tag.
 * That is how this shipped. So the check that matters here resolves the URL
 * the BUILT function would declare, fetches it over HTTP, and decodes the
 * bytes that come back. Nothing is asserted about a path that was not fetched.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { events } from '@/data/events';

const PAGE = 'src/pages/events/[slug].astro';

/** `Base.astro`'s own default, and the one share image that always worked. */
const DEFAULT_SHARE_IMAGE = '/og-card.jpg';

/** What `twitter:card = summary_large_image` asks for. */
const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

describe('every event declares a share image that resolves', () => {
  it('has events to check, so the per-event suites below are not empty', () => {
    expect(events.length).toBeGreaterThan(0);
  });

  /**
   * A source assertion, and the only kind available for this one line.
   *
   * The page is `prerender = false`, and `.astro` is not transformable in this
   * vitest setup, so the `image=` expression cannot be rendered here — the
   * fetch of the real rendered meta tag is `scripts/dev/share-cards-audit.mjs`,
   * run against a deployment. What this can do is refuse the shape of the bug: a data-layer key
   * reaching the layout without passing through `asset()`.
   */
  it('never passes a raw data-layer key to the layout', () => {
    // Comments stripped first: this file and the page both have to NAME the
    // broken expression in order to explain it, and prose is not code.
    const page = readFileSync(PAGE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // The exact line that was wrong, and the near-misses. `coverImage` is a
    // key for `asset()`, not a URL, and the layout cannot tell the difference.
    expect(page).not.toMatch(/image=\{\s*event\.coverImage/);
    expect(page).not.toMatch(/image=\{\s*`[^`]*\$\{event\.coverImage\}/);

    // Whatever `image=` is given must be a local const, and that const must be
    // derived from `asset(...)`. This is what stops the fix being undone by
    // routing the raw key through a differently-named variable.
    const bound = page.match(/^\s*image=\{([A-Za-z0-9_?.]+)\}\s*$/m);
    expect(bound, 'Base is not given an `image=` at all').toBeTruthy();
    const name = bound![1].replace(/\?\..*$/, '');
    const declaration = page.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
    expect(declaration, `\`${name}\` is passed to image= but never declared here`).toBeTruthy();
    expect(declaration![1]).toMatch(/asset\(|\.src/);

    // And `coverImage` must never be read except through the resolver.
    for (const use of page.matchAll(/event\.coverImage/g)) {
      const before = page.slice(Math.max(0, use.index - 24), use.index);
      expect(before, 'event.coverImage read without asset()').toMatch(/asset\($/);
    }
  });
});

describe('the share images are real pictures of a usable size', () => {
  const coverFiles = events
    .map((e) => e.coverImage)
    .filter((key): key is string => Boolean(key))
    .map((key) => join('src/assets', key));

  it('has a cover on disk for every event that claims one', () => {
    expect(coverFiles.length).toBeGreaterThan(0);
    for (const file of coverFiles) {
      expect(statSync(file).isFile(), `${file} is missing`).toBe(true);
    }
  });

  it.each([...new Set(coverFiles)])('decodes %s and is no smaller than today', async (file) => {
    const { width, height } = await sharp(file).metadata();
    // A floor, not an equality: replacing a cover with a BIGGER picture is the
    // fix we want, and replacing one with something smaller is a regression.
    // This fails the day a 400px cover is swapped for a 200px one.
    expect(width).toBeGreaterThanOrEqual(400);
    expect(height).toBeGreaterThanOrEqual(400);
  });

  it('has a fallback card that is genuinely card-sized', async () => {
    // The nine events with no cover depend on this file entirely.
    const { width, height } = await sharp(join('public', DEFAULT_SHARE_IMAGE)).metadata();
    expect(width).toBe(CARD_WIDTH);
    expect(height).toBe(CARD_HEIGHT);
  });

  /**
   * An event with no cover of its own shows, and shares, its Claude Community plate. One helper
   * decides (`eventPlate`: the cover, else the plate), and the page takes both the head image and
   * the share image from it, so the page and its card never disagree.
   */
  it('falls back to the event’s plate, and every plate is a usable picture of a real event', async () => {
    expect(readFileSync('src/lib/event-plate.ts', 'utf8')).toContain(
      'asset(event.coverImage ?? undefined) ?? asset(`plates/${event.slug}.jpg`)',
    );
    const page = readFileSync(PAGE, 'utf8');
    expect(page).toMatch(/const plate = eventPlate\(event\);/);
    expect(page).toMatch(/const shareImage = plate\?\.src;/);
    expect(page).toMatch(/<Image[\s\S]{0,80}src=\{plate\}/);
    const slugs = new Set(events.map((e) => e.slug));
    for (const file of readdirSync('src/assets/plates')) {
      expect(slugs.has(file.replace(/\.jpg$/, '')), `${file} names no event`).toBe(true);
      const { width, height } = await sharp(join('src/assets/plates', file)).metadata();
      expect(Math.min(width!, height!), file).toBeGreaterThanOrEqual(400);
    }
  });
});

/**
 * The real check: resolve through the code that runs in production, then fetch.
 *
 * The event page is `prerender = false`, so there is no event HTML in a local
 * build to read a meta tag out of — it is a serverless function that reads the
 * database per request. What CAN be checked without a database is the half
 * that was broken: the resolver the built function uses, and whether the URL
 * it returns is actually served by the built static output. The end-to-end
 * fetch of the page itself runs against a real deployment in
 * `scripts/dev/share-cards-audit.mjs`, by hand for now.
 */
describe('the built output serves every share image it declares', () => {
  const STATIC = '.vercel/output/static';
  const CHUNKS = '.vercel/output/functions/_render.func/dist/server/chunks';

  let built = false;
  let resolve: ((key: string | undefined) => { src: string } | undefined) | undefined;
  let origin = '';
  let server: ReturnType<typeof createServer> | undefined;

  beforeAll(async () => {
    if (!existsSync(STATIC) || !existsSync(CHUNKS)) return;
    const chunk = readdirSync(CHUNKS).find((f) => /^images_.*\.mjs$/.test(f));
    if (!chunk) return;

    // Rollup renames the export, so take the alias when the name is gone.
    const mod = await import(join(process.cwd(), CHUNKS, chunk));
    resolve = mod.asset ?? mod.a;
    if (typeof resolve !== 'function') return;

    // Serve the built static directory so these are real HTTP requests with
    // real status codes, rather than an `existsSync` wearing a costume.
    server = createServer((req, res) => {
      const path = join(process.cwd(), STATIC, decodeURIComponent((req.url ?? '/').split('?')[0]));
      if (!path.startsWith(join(process.cwd(), STATIC)) || !existsSync(path)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.end(readFileSync(path));
    });
    await new Promise<void>((done) => server!.listen(0, done));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    built = true;
  });

  afterAll(() => server?.close());

  it.each(events.map((e) => [e.slug, e.coverImage] as const))(
    'serves the share image declared by %s',
    async (slug, coverImage) => {
      if (!built || !resolve) {
        // Say so rather than pass quietly. A check that stops running without
        // anyone noticing is how the original defect survived this long.
        console.warn(`no build at ${STATIC} — run \`npm run build\` first (skipped ${slug})`);
        return;
      }

      // The page's own fallback order: the cover, then the event's plate, then the card.
      const declared =
        (resolve(coverImage) ?? resolve(`plates/${slug}.jpg`))?.src ?? DEFAULT_SHARE_IMAGE;
      const response = await fetch(origin + declared);
      expect(response.status, `${slug} declares ${declared}`).toBe(200);

      // Decode the response body, not the file on disk: this is what an
      // unfurler receives, and a 200 serving a broken byte range is still
      // a card with no picture.
      const { width, height } = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      expect(width, `${slug} → ${declared}`).toBeGreaterThanOrEqual(400);
      expect(height, `${slug} → ${declared}`).toBeGreaterThanOrEqual(400);

      // `Base.astro` publishes `new URL(image, site.url)`. Absolute is a hard
      // requirement for every unfurler, so assert the composition too.
      expect(new URL(declared, 'https://www.withclaude.in').href).toBe(
        `https://www.withclaude.in${declared}`,
      );
    },
  );
});
