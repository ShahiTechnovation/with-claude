#!/usr/bin/env tsx
/**
 * LOCAL ONLY — run the real Luma ICS ingestion against the committed feed
 * snapshot (`luma-sample.ics`) instead of the network.
 *
 * Only `fetch` for the feed URL is answered from the file; parsing,
 * normalisation, India/city placement, matching to curated events and
 * promotion are the production code paths. That is how a local database gets
 * the events production has from Luma — including the Bhopal Fable 5.1 Build
 * Day — without anyone hand-inserting rows.
 *
 *   DATABASE_URL=postgresql://…@127.0.0.1:…/db npx tsx scripts/dev/ingest-sample-feed.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { pooledDb } from '../../db/pool';
import { LumaIcsSource } from '../../src/server/events/luma';
import { syncSource } from '../../src/server/events/sync';

const url = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
  console.error('ingest-sample-feed only runs against a local database.');
  process.exit(1);
}

const source = new LumaIcsSource();
const body = readFileSync(new URL('../../luma-sample.ics', import.meta.url), 'utf8');
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === source.feedUrl) {
    return new Response(body, { status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const summary = await syncSource(source, pooledDb());
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
