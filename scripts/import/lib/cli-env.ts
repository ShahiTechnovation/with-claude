/**
 * Shared CLI plumbing for the importer commands: argument parsing, the
 * database safety rail, and the Baserow writer — real API or, for a local
 * rehearsal, the file-backed fixture.
 */
import { createBaserowClient } from '../../../src/server/integrations/baserow/client';
import { baserowSettings } from '../../../src/server/integrations/baserow/config';
import { FileBaserow } from './file-baserow';

const args = process.argv.slice(3);

export const flag = (name: string) => args.includes(`--${name}`);
export const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
export const positional = () => args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

export function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

export function isLocalDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? '').hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

export function guardDatabase() {
  const url = process.env.DATABASE_URL ?? '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    fail('DATABASE_URL is not set or not a URL.');
  }
  const local = isLocalDatabase();
  console.log(`Database: ${host}${local ? ' (local)' : ''}`);
  if (!local && !flag('allow-remote-db')) {
    fail('Refusing to use a non-local database without --allow-remote-db. Rehearse against a local or staging copy first.');
  }
}

/** `BASEROW_FIXTURE=imports/<file>.json` — the local stand-in. */
export const FIXTURE = process.env.BASEROW_FIXTURE?.trim() || null;

export function fixture(): FileBaserow {
  if (!FIXTURE) fail('BASEROW_FIXTURE is not set.');
  if (!isLocalDatabase()) fail('The file-backed Baserow fixture may only be used with a local DATABASE_URL.');
  if (!FIXTURE.replace(/\\/g, '/').startsWith('imports/')) fail('BASEROW_FIXTURE must be a file under imports/ (git-ignored).');
  // A rehearsal of a REAL workspace: the fixture file mirrors that workspace's
  // schema, and BASEROW_CONFIG carries its real table and field ids.
  const s = baserowSettings();
  return s.config ? new FileBaserow(FIXTURE, s.config) : new FileBaserow(FIXTURE);
}

export function settings() {
  const s = baserowSettings();
  if (!s.config) fail(s.problem ?? 'BASEROW_CONFIG is not set (see config/baserow.example.json).');
  return s;
}

/** The importer's write client: the fixture when rehearsing, otherwise the real API with the import token. */
export function writer() {
  if (FIXTURE) {
    const f = fixture();
    console.log(`Baserow: file fixture ${FIXTURE} (local rehearsal — not the real Baserow)`);
    return { client: f, config: f.config };
  }
  const s = settings();
  const token = process.env.BASEROW_IMPORT_TOKEN?.trim();
  if (!token) fail('BASEROW_IMPORT_TOKEN is not set. Use a token scoped to the Projects and Credits tables.');
  return { client: createBaserowClient({ baseUrl: s.apiUrl, token, maxConcurrency: 3 }), config: s.config! };
}
