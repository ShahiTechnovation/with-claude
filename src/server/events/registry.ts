/**
 * WHICH SOURCES THIS DEPLOYMENT ACTUALLY HAS.
 *
 * One function answers it, so that "what is ingesting events" is a question
 * with a single truthful answer rather than something inferred from which
 * environment variables happen to be set in which file.
 *
 * The order is a preference order: the most privileged usable source wins. If
 * a real API key ever appears, the API source is chosen and the ICS source
 * steps aside — without a code change, which is the whole reason §17 asked for
 * an abstraction.
 */
import { CLAUDE_COMMUNITY_CALENDAR_ID, LumaApiSource, LumaIcsSource, lumaIcsUrl } from './luma';
import type { EventSource, FetchResult, NormalizedEvent } from './source';

/**
 * Events entered by hand, held in memory.
 *
 * §17 asks for this alongside the two Luma modes. It is not a stub: it is what
 * makes the sync testable without a network, and it is the path a curated
 * event would take if one ever needed to go through normalisation rather than
 * being authored directly into `events`.
 *
 * `complete` is a constructor option because that flag is the difference
 * between "here is the whole calendar" and "here is one event", and a manual
 * source can legitimately be either. Defaulting it to false is the safe
 * choice — see the warning on `FetchResult.complete`.
 */
export class ManualEventSource implements EventSource {
  readonly provider = 'manual';
  readonly syncMode = 'manual' as const;
  readonly key: string;
  readonly label: string;

  private readonly events: NormalizedEvent[];
  private readonly complete: boolean;

  constructor(
    events: NormalizedEvent[],
    options: { key?: string; label?: string; complete?: boolean } = {},
  ) {
    this.events = events;
    this.complete = options.complete ?? false;
    this.key = options.key ?? 'manual';
    this.label = options.label ?? 'Manual entry';
  }

  async fetch(): Promise<FetchResult> {
    return { ok: true, events: this.events, complete: this.complete, note: `manual ${this.events.length} events` };
  }
}

/**
 * Every configured source, most privileged first.
 *
 * ── WHAT IS CONFIGURED TODAY ─────────────────────────────────────────────
 *
 * The ICS source, and only the ICS source. It needs no credential, so it is
 * always available — which is deliberate: the events directory should not go
 * dark because a key was never added.
 *
 * `LUMA_ICS_URL` can override the feed URL, and `LUMA_CALENDAR_ID` the
 * calendar, for the case where this community points at a different calendar.
 * Neither is required; the default is the calendar we actually run on.
 */
export function configuredEventSources(env: NodeJS.ProcessEnv = process.env): EventSource[] {
  const sources: EventSource[] = [];

  // Privileged, and absent unless a real key exists. `create()` returns null
  // rather than a source that pretends — see §18.
  const api = LumaApiSource.create(env);
  if (api) sources.push(api);

  const calendarId = env.LUMA_CALENDAR_ID?.trim() || CLAUDE_COMMUNITY_CALENDAR_ID;
  const feedUrl = env.LUMA_ICS_URL?.trim() || lumaIcsUrl(calendarId);
  sources.push(new LumaIcsSource({ calendarId, feedUrl }));

  return sources;
}

/**
 * The mode the deployment is in, for honest reporting.
 *
 * §56 forbids calling a scheduled job realtime. This is what the health
 * endpoint and the docs read so the claim is derived from configuration rather
 * than written by hand and left to rot.
 */
export function ingestionMode(env: NodeJS.ProcessEnv = process.env): {
  mode: 'api' | 'webhook' | 'ics';
  realtime: false;
  description: string;
} {
  if (env.LUMA_API_KEY?.trim()) {
    return {
      mode: 'api',
      realtime: false,
      description: 'Luma API, polled on the configured schedule.',
    };
  }
  if (env.LUMA_WEBHOOK_SECRET?.trim()) {
    return {
      mode: 'webhook',
      realtime: false,
      description: 'Luma webhook, near-real-time, with scheduled reconciliation.',
    };
  }
  return {
    mode: 'ics',
    realtime: false,
    description: 'Public Luma iCal feed, fetched on a schedule. Not realtime.',
  };
}
