/**
 * WHY A PUBLIC READ FAILED — said honestly, without leaking internals.
 *
 * A page that cannot reach its data answers 503 with a plain "could not load"
 * state instead of a stack-trace 500. The one case worth naming is a database
 * that is BEHIND the code (a column or table this release adds does not exist
 * yet): that is a deployment-order mistake — migrate, then deploy — and in
 * development the page says so. Production visitors only ever see the
 * generic message; the detail goes to the server log.
 */

export type ReadFailure = 'schema-behind' | 'unavailable';

/** PostgreSQL: undefined_column (42703), undefined_table (42P01), undefined_object (42704). */
const SCHEMA_CODES = new Set(['42703', '42P01', '42704']);

export function classifyReadFailure(error: unknown): ReadFailure {
  for (let e: unknown = error, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && SCHEMA_CODES.has(code)) return 'schema-behind';
    const message = (e as { message?: unknown }).message;
    if (typeof message === 'string' && /(column|relation|type) "?[\w.]+"? does not exist/i.test(message)) return 'schema-behind';
  }
  return 'unavailable';
}

export function logReadFailure(where: string, error: unknown): ReadFailure {
  const kind = classifyReadFailure(error);
  const cause = (error as { cause?: { message?: string } })?.cause?.message ?? (error as Error)?.message ?? String(error);
  console.error(
    `[${where}] public read failed (${kind})${kind === 'schema-behind' ? ' — the database is missing migrations: run `npm run db:migrate` against this DATABASE_URL' : ''}: ${String(cause).slice(0, 300)}`,
  );
  return kind;
}
