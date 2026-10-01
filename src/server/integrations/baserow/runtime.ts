/**
 * Wiring for deployed functions: settings → client → bounded runs.
 *
 * Both entry points (the webhook and the cron) go through `runSync()`, so
 * there is one place that decides the time budget, records a run, and refuses
 * to do anything while the feature flag is off.
 */
import { pooledDb } from '../../../../db/pool';
import { createBaserowClient } from './client';
import { baserowSettings, type BaserowSettings } from './config';
import { endRun, pruneJobs, reconcile, runQueue, startRun, type RunCounts } from './sync';

/** Vercel functions here are capped at 15 s; leave room for the response. */
export const WEBHOOK_BUDGET_MS = 8_000;
export const CRON_BUDGET_MS = 12_000;

export function readySettings(): (BaserowSettings & { config: NonNullable<BaserowSettings['config']>; readToken: string }) | null {
  const settings = baserowSettings();
  if (!settings.enabled || settings.problem || !settings.config || !settings.readToken) return null;
  return settings as BaserowSettings & { config: NonNullable<BaserowSettings['config']>; readToken: string };
}

export async function runSync(
  trigger: 'webhook' | 'reconcile' | 'manual',
  options: { reconcileFirst: boolean; budgetMs: number },
): Promise<{ ran: boolean; reason?: string; counts?: RunCounts; reconcile?: unknown }> {
  const settings = readySettings();
  if (!settings) {
    const s = baserowSettings();
    return { ran: false, reason: s.enabled ? (s.problem ?? 'not configured') : 'disabled' };
  }
  const db = pooledDb();
  const client = createBaserowClient({ baseUrl: settings.apiUrl, token: settings.readToken });
  const started = Date.now();
  const runId = await startRun(db, trigger);
  try {
    const report = options.reconcileFirst ? await reconcile(db, client, settings.config) : undefined;
    const remaining = Math.max(1_000, options.budgetMs - (Date.now() - started));
    const counts = await runQueue(db, client, settings.config, { budgetMs: remaining, trigger });
    await endRun(db, runId, { ...counts, ...(report ? { reconcile: report } : {}) });
    if (trigger === 'reconcile') await pruneJobs(db);
    return { ran: true, counts, reconcile: report };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    await endRun(db, runId, {}, message);
    return { ran: false, reason: 'run failed' };
  }
}
