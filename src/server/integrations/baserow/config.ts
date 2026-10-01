/**
 * BASEROW CONFIGURATION — server-only, default OFF.
 *
 *   BASEROW_SYNC_ENABLED     "true" to run the projection at all. Anything
 *                            else is off: webhooks are acknowledged and
 *                            ignored, reconciliation does nothing, and the
 *                            last projection in Neon keeps serving the site.
 *   BASEROW_API_URL          default https://api.baserow.io
 *   BASEROW_READ_TOKEN       a database token with READ on the four tables only
 *   BASEROW_WEBHOOK_SECRET   high-entropy value Baserow sends in a custom header
 *   BASEROW_CONFIG           JSON: table ids and field ids (see
 *                            config/baserow.example.json)
 *
 * The importer's WRITE token (`BASEROW_IMPORT_TOKEN`) is read only by the CLI,
 * never by a deployed function. None of these is ever `PUBLIC_`-prefixed.
 */
import { z } from 'zod';
import { SPEC, type TableKey } from './spec';

const ids = z.number().int().positive();

const TableConfig = z.object({
  tableId: ids,
  fields: z.record(z.string(), ids),
});

export const ConfigSchema = z
  .object({
    tables: z.object({
      cities: TableConfig,
      events: TableConfig,
      projects: TableConfig,
      credits: TableConfig,
    }),
  })
  .superRefine((value, ctx) => {
    for (const table of Object.keys(SPEC) as TableKey[]) {
      for (const key of Object.keys(value.tables[table].fields)) {
        if (!(key in SPEC[table])) {
          ctx.addIssue({ code: 'custom', message: `tables.${table}.fields.${key} is not a known field` });
        }
      }
    }
  });

export type BaserowConfig = z.infer<typeof ConfigSchema>;

export interface BaserowSettings {
  enabled: boolean;
  apiUrl: string;
  readToken: string | null;
  webhookSecret: string | null;
  config: BaserowConfig | null;
  /** A fixed, safe explanation when something required is missing. */
  problem: string | null;
}

export function baserowSettings(env: NodeJS.ProcessEnv = process.env): BaserowSettings {
  const enabled = env.BASEROW_SYNC_ENABLED?.trim().toLowerCase() === 'true';
  const apiUrl = env.BASEROW_API_URL?.trim() || 'https://api.baserow.io';
  const readToken = env.BASEROW_READ_TOKEN?.trim() || null;
  const webhookSecret = env.BASEROW_WEBHOOK_SECRET?.trim() || null;

  let config: BaserowConfig | null = null;
  let problem: string | null = null;
  const raw = env.BASEROW_CONFIG?.trim();
  if (raw) {
    try {
      const parsed = ConfigSchema.safeParse(JSON.parse(raw));
      if (parsed.success) config = parsed.data;
      else problem = `BASEROW_CONFIG is invalid: ${parsed.error.issues[0]?.message ?? 'shape'}`;
    } catch {
      problem = 'BASEROW_CONFIG is not valid JSON';
    }
  }
  if (enabled && !problem) {
    if (!readToken) problem = 'BASEROW_READ_TOKEN is not set';
    else if (!config) problem = 'BASEROW_CONFIG is not set';
    else if (!webhookSecret || webhookSecret.length < 32) {
      problem = 'BASEROW_WEBHOOK_SECRET must be set and at least 32 characters';
    }
  }
  return { enabled, apiUrl, readToken, webhookSecret, config, problem };
}

/** Which logical table a Baserow table id is, if it is one of ours. */
export function tableKeyFor(config: BaserowConfig, tableId: number): TableKey | null {
  for (const key of Object.keys(config.tables) as TableKey[]) {
    if (config.tables[key].tableId === tableId) return key;
  }
  return null;
}
