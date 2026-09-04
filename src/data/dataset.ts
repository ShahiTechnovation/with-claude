/**
 * THE DATASET THE BUILD RENDERS FROM.
 *
 * One `RecordSet`, loaded once, read synchronously by every selector in
 * `src/data/index.ts` and therefore by every page and component on the site.
 *
 * ── WHY THIS IS SYNCHRONOUS, WHICH IS THE WHOLE DESIGN ───────────────────
 *
 * A database read is asynchronous and `src/data/index.ts` is not. It exports
 * around forty things, and most of them are module-scope constants
 * (`publicBuilders`, `cityBySlug`, `eventsChronological`) or synchronous
 * functions built on top of them (`nationalSignal()`, `citySignal()`,
 * `timeline()`, `photoRecord()`). Roughly fifty files consume them, including
 * inside `getStaticPaths`, and `astro.config.mjs` reaches the same record
 * through `src/lib/indexable.ts` before the `@` alias even exists.
 *
 * Turning those exports async would mean editing every one of those fifty
 * consumers, which is precisely the rewrite this migration is supposed to
 * avoid — the point of having an abstraction boundary is that moving what is
 * behind it does not move what is in front of it.
 *
 * So the asynchrony is moved OUT of the render and into a step before it:
 *
 *     npm run build
 *       ├── prebuild   read PostgreSQL once  →  .astro/dataset.json
 *       └── astro build   every page reads that file synchronously
 *
 * With `DATA_SOURCE=ts` there is no snapshot and no prebuild: the record is
 * imported directly, exactly as it always has been. That is what makes the
 * rollback total — on the TypeScript path this module is a pass-through, and
 * not one line of the previous behaviour is going through new machinery.
 *
 * ── WHY A FILE AND NOT A TOP-LEVEL AWAIT ─────────────────────────────────
 *
 * Because `astro.config.mjs` needs the same records, and a config that awaits
 * a database is a config that cannot be loaded without one — `astro check`,
 * the test suite and `astro dev` would all start requiring a live connection.
 * A snapshot on disk is readable by the config, the pages and the sitemap
 * filter alike, with no import graph tricks and no driver in the browser
 * bundle.
 *
 * It also happens to give §26 and §27 for free and by construction: one
 * finite load per build, in memory for every page, with no possibility of a
 * per-page query because there is no connection open at render time at all.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dataSourceName, type DataSourceName, type RecordSet } from './source';
import { tsRecordSet } from './source-ts';

/**
 * Where the prebuild writes its snapshot.
 *
 * Inside `.astro/`, which is already the build's scratch directory and already
 * git-ignored. It is a build artefact and must never be committed: a stale
 * snapshot in the repository is a copy of the record that looks authoritative
 * and is not, which is the exact hazard §15 warns about.
 *
 * ── WHY THIS IS RESOLVED FROM THE WORKING DIRECTORY ──────────────────────
 *
 * `import.meta.url` would be the obvious way to find it, and it is wrong here.
 * Vite bundles this module into `dist/server/chunks/`, so a path relative to
 * the module resolves somewhere different at build time than it did in source
 * — the build fails looking for `dist/server/.astro/dataset.json`, which is
 * nowhere.
 *
 * `process.cwd()` is stable across both, because the prebuild and `astro
 * build` are two commands in the same `npm run build`, run from the project
 * root. `SNAPSHOT_DIR` overrides it for anything that needs to say otherwise.
 */
export const SNAPSHOT_PATH = resolve(
  process.env.SNAPSHOT_DIR ?? join(process.cwd(), '.astro'),
  'dataset.json',
);

/** What the prebuild writes. Versioned so a stale shape fails loudly. */
export interface Snapshot {
  version: 1;
  source: DataSourceName;
  /** When the snapshot was taken. Reported by the build, never rendered. */
  generatedAt: string;
  records: RecordSet;
}

export const SNAPSHOT_VERSION = 1 as const;

let cached: RecordSet | undefined;

/**
 * The record for this build.
 *
 * Memoized for the life of the process. A build renders around ninety pages
 * and most of them touch several selectors, so this is called hundreds of
 * times and does its work once.
 */
export function records(): RecordSet {
  if (cached) return cached;
  cached = dataSourceName() === 'db' ? readSnapshot() : tsRecordSet();
  return cached;
}

/** Which source the current dataset came from. For build logs and tests. */
export function activeSource(): DataSourceName {
  return dataSourceName();
}

/**
 * Read the snapshot the prebuild wrote.
 *
 * Every failure here is loud and specific. A missing or unreadable snapshot
 * must never degrade to the TypeScript record: a `DATA_SOURCE=db` build that
 * quietly renders from `src/data/*.ts` would report success having verified
 * nothing, and somebody would believe the database path worked.
 */
function readSnapshot(): RecordSet {
  let raw: string;
  try {
    raw = readFileSync(SNAPSHOT_PATH, 'utf8');
  } catch {
    throw new Error(
      `DATA_SOURCE=db but there is no dataset snapshot at ${SNAPSHOT_PATH}.\n` +
        `The database is read once, before the build, by \`npm run prebuild\` — ` +
        `\`npm run build\` does this for you. Run the build rather than \`astro build\` ` +
        `directly, or set DATA_SOURCE=ts to render from the TypeScript record.`,
    );
  }

  const snapshot = JSON.parse(raw) as Snapshot;

  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `The dataset snapshot at ${SNAPSHOT_PATH} is version ${String(snapshot.version)}; ` +
        `this build expects ${SNAPSHOT_VERSION}. Delete it and re-run the build.`,
    );
  }
  if (snapshot.source !== 'db') {
    throw new Error(
      `DATA_SOURCE=db but the snapshot was taken from "${snapshot.source}". ` +
        `Delete ${SNAPSHOT_PATH} and re-run the build.`,
    );
  }

  return snapshot.records;
}

/**
 * Replace the dataset. TEST ONLY.
 *
 * The equivalence suite needs to evaluate the whole selector layer against two
 * different record sets in one process, which is the only reason a setter
 * exists. Nothing in `src/` calls it, and nothing should: a build has one
 * dataset, decided by one environment variable, before the first page renders.
 */
export function __setRecords(next: RecordSet | undefined): void {
  cached = next;
}

/**
 * A value derived from the dataset, computed once per dataset.
 *
 * `src/data/index.ts` exports a dozen or so derived collections —
 * `publicBuilders`, `eventsChronological`, `cityBySlug` and the rest. They
 * were plain module-scope constants, which was correct for a build (one
 * dataset per process, so a constant is a cache with perfect hit rate) and
 * wrong for anything that needs to evaluate the selector layer against two
 * datasets in one process. The equivalence suite needs exactly that, and with
 * frozen constants it silently compared the first dataset with itself and
 * passed — which is a worse failure than not having the suite.
 *
 * So each one becomes a getter over this: memoized on the IDENTITY of the
 * record set it was computed from. Same dataset, same object, computed once.
 * Different dataset, recomputed. A build gets exactly the previous behaviour;
 * a test that swaps the dataset gets an honest answer.
 */
export function derived<T>(compute: (records: RecordSet) => T): () => T {
  let forDataset: RecordSet | undefined;
  let value: T;
  return () => {
    const current = records();
    if (forDataset !== current) {
      value = compute(current);
      forDataset = current;
    }
    return value;
  };
}

/**
 * A live array view over a derived value.
 *
 * `src/data/index.ts` exports collections as VALUES — `publicBuilders.map(…)`,
 * `[...eventsChronological]`, `cityBySlug.get(slug)`. Fifty files read them
 * that way and this migration is explicitly not a rewrite of those fifty
 * files, so the exports have to stay values while becoming lazy.
 *
 * A Proxy is what makes both true at once. Every read forwards to the memoized
 * array for the CURRENT dataset, so the export behaves as an ordinary array —
 * indexing, iteration, spread, `length`, every method — while the array it
 * behaves as is resolved at the moment of the read rather than at import.
 *
 * The cost is one property-lookup indirection per access, on a build that
 * renders ninety static pages. Measured against the alternative — editing
 * fifty consumers to await an accessor — it is not a trade worth thinking
 * about twice.
 */
export function listProxy<T>(read: () => T[]): ProxyHandler<T[]> {
  return {
    get(_target, property, receiver) {
      const list = read();
      const value = Reflect.get(list, property, receiver);
      return typeof value === 'function' ? value.bind(list) : value;
    },
    has: (_target, property) => Reflect.has(read(), property),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, property) =>
      Reflect.getOwnPropertyDescriptor(read(), property),
    getPrototypeOf: () => Array.prototype,
  };
}

/** The same, for a `Map` lookup exported as a value. */
export function mapProxy<K, V>(read: () => Map<K, V>): ProxyHandler<Map<K, V>> {
  return {
    get(_target, property, receiver) {
      const map = read();
      const value = Reflect.get(map, property, receiver);
      return typeof value === 'function' ? value.bind(map) : value;
    },
    has: (_target, property) => Reflect.has(read(), property),
    getPrototypeOf: () => Map.prototype,
  };
}
