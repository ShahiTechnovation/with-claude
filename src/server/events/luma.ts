/**
 * LUMA, IN THE TWO MODES WE MIGHT ACTUALLY HAVE.
 *
 * ── WHICH MODE THIS PROJECT IS IN, TODAY ─────────────────────────────────
 *
 * ICS. We do not administer the Claude Community calendar and hold no API key
 * or webhook secret for it. §18 and §56 are explicit that this must not be
 * dressed up: what runs is a SCHEDULED FETCH of a public iCal feed, and the
 * word "realtime" does not apply to it.
 *
 * `LumaApiSource` exists and is wired, but it is inert without
 * `LUMA_API_KEY`. It is here so that the day someone grants calendar-scoped
 * access, the change is an environment variable rather than a rewrite — not
 * because it is running.
 *
 * ── THE ICS URL, WHICH IS NOT GUESSABLE ──────────────────────────────────
 *
 *   https://api.lu.ma/ics/get?entity=calendar&id=cal-TOpA5LAFfuDeFpu
 *
 * Two things about that URL cost real time to establish, so they are written
 * down rather than left to be rediscovered:
 *
 *  1. The `id` MUST be the calendar's internal `api_id` (`cal-…`). The public
 *     slug does not work — `?id=claudecommunity` answers 404 with
 *     `{"message":"Sorry, we could not find what you were looking for."}`.
 *     The `api_id` is discoverable once, from the calendar page's own HTML
 *     (`"api_id":"cal-…"`), which is a single request, not scraping.
 *
 *  2. The host MUST be `api.lu.ma`. `lu.ma/ics/get?…` and
 *     `luma.com/ics/…` both answer 200 with the Next.js HTML shell, which a
 *     parser reads as a calendar containing zero events — the worst possible
 *     failure, because it looks like success. `parseIcs` returning no events
 *     from a 200 is therefore treated as a FAILURE and not as an empty
 *     calendar; see the content-type and sentinel checks below.
 *
 * Verified against the live feed: 317 `VEVENT`s, `text/calendar`,
 * `REFRESH-INTERVAL:PT12H`.
 */
import { parseIcs, parseIcsDate, text, type IcsEvent } from './ics';
import type { EventSource, FetchResult, NormalizedEvent } from './source';

/** The calendar this community actually runs on. */
export const CLAUDE_COMMUNITY_CALENDAR_ID = 'cal-TOpA5LAFfuDeFpu';

export function lumaIcsUrl(calendarId: string): string {
  // `api.lu.ma`, not `lu.ma`. See the note above.
  return `https://api.lu.ma/ics/get?entity=calendar&id=${encodeURIComponent(calendarId)}`;
}

/** A polite, identifiable agent. A feed owner should be able to tell who this is. */
const USER_AGENT = 'WithClaude/1.0 (+https://www.withclaude.in)';

/** One fetch should not be able to hang a cron invocation. */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Strip the Luma `UID` down to its stable event id.
 *
 * The feed sends `evt-RPZwseE12orCSQ0@events.lu.ma`. The domain is noise, and
 * dropping it means an id from the ICS feed and an id from the API are the
 * same string — which is what lets a source switch from `ics` to `api` without
 * re-importing every event as new.
 */
export function lumaExternalId(uid: string): string {
  const at = uid.indexOf('@');
  return (at === -1 ? uid : uid.slice(0, at)).trim();
}

/**
 * Pull the event's own Luma URL out of the description.
 *
 * The feed opens every description with
 * `Get up-to-date information at: https://luma.com/<slug>`, and that is the
 * registration page. It is worth extracting because the alternative — building
 * a URL from the event id — produces a link that works today and breaks the
 * moment the organiser changes the slug, which §24 explicitly warns against.
 *
 * When the description has no link, the caller falls back to the `LOCATION`
 * field if that is itself a Luma URL, which is how the registrant-only events
 * in this feed present themselves.
 */
export function lumaUrlFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = /https:\/\/(?:luma\.com|lu\.ma)\/[A-Za-z0-9._~-]+/.exec(description);
  return match?.[0];
}

/** `GEO:47.3749384;8.538244299999999` → two numbers, or nothing. */
export function parseGeo(value: string | undefined): { lat: number; lon: number } | undefined {
  if (!value) return undefined;
  const [rawLat, rawLon] = value.split(';');
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  // 0,0 is in the Atlantic. It is what a missing value looks like when a
  // producer fills the field in anyway, so it is treated as absent.
  if (lat === 0 && lon === 0) return undefined;
  return { lat, lon };
}

/**
 * The address a human would read, out of the description block.
 *
 * The feed formats it as `…\n\nAddress:\n<lines>\n\nHosted by <name>`, which is
 * strictly better than `LOCATION` for the registrant-only events: `LOCATION`
 * is a bare URL for those, while the description block still names the city
 * and country. Used to enrich the location text, never to override a real
 * `LOCATION`.
 */
export function lumaAddressFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = /\n\s*Address:\s*\n([\s\S]*?)(?:\n\s*\n|$)/.exec(description);
  if (!match) return undefined;
  const address = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ');
  return address || undefined;
}

/** `Hosted by <name>`, the only organiser string the ICS description carries. */
export function lumaHostFromDescription(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = /\n\s*Hosted by\s+(.+?)\s*$/.exec(description);
  return match?.[1]?.trim() || undefined;
}

/** `ORGANIZER;CN="Xavier (최훈민)":MAILTO:…` → the display name. */
function organizerName(event: IcsEvent): string | undefined {
  const cn = event.ORGANIZER?.params.CN;
  if (!cn) return undefined;
  const value = cn.replace(/^"|"$/g, '').trim();
  // The feed uses a shared mailbox for every event, so a CN equal to the
  // calendar itself carries no information about who is hosting.
  if (!value || value.toLowerCase() === 'luma') return undefined;
  return value;
}

/** One `VEVENT` → one `NormalizedEvent`, or null if it is unusable. */
export function normalizeLumaIcsEvent(event: IcsEvent): NormalizedEvent | null {
  const uid = text(event, 'UID');
  const title = text(event, 'SUMMARY');
  const start = parseIcsDate(event.DTSTART);

  // An event with no id, no title or no start is not an event. Skipped rather
  // than defaulted, because every default here would be an invention.
  if (!uid || !title || !start) return null;

  const externalId = lumaExternalId(uid);
  if (!externalId) return null;

  const description = text(event, 'DESCRIPTION');
  const end = parseIcsDate(event.DTEND);
  const geo = parseGeo(text(event, 'GEO'));

  const locationField = text(event, 'LOCATION');
  const addressFromDescription = lumaAddressFromDescription(description);

  /**
   * Prefer a real address over a URL.
   *
   * `LOCATION` is authoritative when it is an address. When it is a Luma URL —
   * which is how this feed marks a registrant-only venue — the description's
   * `Address:` block is the only text that names the city, so it is used
   * instead. Getting this the wrong way round is what sends a real Bhopal
   * event to the review queue.
   */
  const locationIsUrl = Boolean(locationField && /^https?:\/\//i.test(locationField));
  const location = locationIsUrl ? (addressFromDescription ?? locationField) : locationField;

  const registrationUrl =
    lumaUrlFromDescription(description) ?? (locationIsUrl ? locationField : undefined);

  const sequence = Number(text(event, 'SEQUENCE'));

  return {
    externalId,
    title,
    description,
    startsAt: start.date,
    endsAt: end?.date,
    // Only when the source actually named a zone. All events in this feed are
    // absolute UTC, so this is normally undefined rather than guessed.
    timezone: start.zone,
    location,
    latitude: geo?.lat,
    longitude: geo?.lon,
    organizer: organizerName(event) ?? lumaHostFromDescription(description),
    registrationUrl,
    sequence: Number.isFinite(sequence) ? sequence : undefined,
    status: text(event, 'STATUS'),
  };
}

async function fetchText(url: string): Promise<{ ok: true; body: string; contentType: string } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1', 'user-agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) return { ok: false, reason: `HTTP_${response.status}` };
    return {
      ok: true,
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
    };
  } catch (error) {
    // The URL is not echoed and the error is not stringified — a feed URL is
    // public here, but this helper must stay safe for one that is not.
    return { ok: false, reason: (error as Error)?.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The public iCal feed. The mode this project actually runs in.
 */
export class LumaIcsSource implements EventSource {
  readonly provider = 'luma';
  readonly syncMode = 'ics' as const;
  readonly key: string;
  readonly label: string;
  readonly calendarId: string;
  readonly feedUrl: string;

  constructor(options: { key?: string; label?: string; calendarId?: string; feedUrl?: string } = {}) {
    this.calendarId = options.calendarId ?? CLAUDE_COMMUNITY_CALENDAR_ID;
    this.key = options.key ?? 'luma:claudecommunity';
    this.label = options.label ?? 'Claude Community (Luma, iCal)';
    this.feedUrl = options.feedUrl ?? lumaIcsUrl(this.calendarId);
  }

  async fetch(): Promise<FetchResult> {
    const response = await fetchText(this.feedUrl);
    if (!response.ok) return { ok: false, reason: response.reason };

    /**
     * A 200 THAT IS NOT A CALENDAR IS A FAILURE.
     *
     * This is the check that matters most in the file. `lu.ma/ics/get?…`
     * returns 200 and an HTML page; parsing it yields a calendar with zero
     * events, and a sync that believed it would mark every event in the
     * database withdrawn — silently emptying the events directory in response
     * to a URL typo. So a body that is not a calendar is rejected before it
     * can be interpreted as an empty one.
     */
    const looksLikeCalendar =
      response.contentType.toLowerCase().includes('text/calendar') ||
      response.body.trimStart().startsWith('BEGIN:VCALENDAR');
    if (!looksLikeCalendar) return { ok: false, reason: 'NOT_A_CALENDAR' };

    const calendar = parseIcs(response.body);

    // Same argument: a calendar that parsed to nothing is far more likely to be
    // a broken feed than a community that cancelled everything.
    if (calendar.events.length === 0) return { ok: false, reason: 'EMPTY_CALENDAR' };

    const events: NormalizedEvent[] = [];
    let skipped = 0;
    for (const raw of calendar.events) {
      const normalized = normalizeLumaIcsEvent(raw);
      if (normalized) events.push(normalized);
      else skipped += 1;
    }

    return {
      ok: true,
      events,
      // The ICS endpoint serves the entire calendar in one response, with no
      // pagination — so absence from this list is meaningful.
      complete: true,
      note: `ics ${events.length} events${skipped ? `, ${skipped} unusable` : ''}${
        calendar.refreshInterval ? `, refresh ${calendar.refreshInterval}` : ''
      }`,
    };
  }
}

/**
 * The privileged path. INERT WITHOUT A KEY, AND THAT IS THE POINT.
 *
 * §18 permits this only when we hold a valid, calendar-scoped credential.
 * `create()` returns null when `LUMA_API_KEY` is absent, so
 * `configuredEventSources()` simply does not include it and the ICS source
 * runs instead. Nothing here fabricates access we do not have.
 *
 * The request shape follows Luma's documented calendar listing endpoint. It is
 * UNVERIFIED AGAINST A LIVE KEY — we have none — so it is written defensively
 * and reports a fixed failure code rather than throwing if the response shape
 * is not what it expects.
 */
export class LumaApiSource implements EventSource {
  readonly provider = 'luma';
  readonly syncMode = 'api' as const;
  readonly key: string;
  readonly label: string;
  readonly calendarId?: string;

  private readonly apiKey: string;

  private constructor(apiKey: string, calendarId?: string) {
    this.apiKey = apiKey;
    this.calendarId = calendarId;
    this.key = 'luma:api';
    this.label = 'Claude Community (Luma API)';
  }

  /** Null when no credential is configured. Never a stub that pretends. */
  static create(env: NodeJS.ProcessEnv = process.env): LumaApiSource | null {
    const apiKey = env.LUMA_API_KEY?.trim();
    if (!apiKey) return null;
    return new LumaApiSource(apiKey, env.LUMA_CALENDAR_ID?.trim() || undefined);
  }

  async fetch(): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch('https://public-api.lu.ma/public/v1/calendar/list-events', {
        // The key travels in a header, never a query string — a URL ends up in
        // logs and `Referer`, and this one would be a credential.
        headers: { 'x-luma-api-key': this.apiKey, accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: `HTTP_${response.status}` };

      const payload = (await response.json()) as { entries?: unknown };
      if (!Array.isArray(payload.entries)) return { ok: false, reason: 'UNEXPECTED_SHAPE' };

      const events: NormalizedEvent[] = [];
      for (const entry of payload.entries) {
        const normalized = normalizeLumaApiEntry(entry);
        if (normalized) events.push(normalized);
      }
      if (events.length === 0) return { ok: false, reason: 'EMPTY_RESPONSE' };

      return {
        ok: true,
        events,
        /**
         * FALSE, deliberately, and this is not laziness.
         *
         * The listing endpoint paginates, and this implementation reads only
         * the first page. Claiming completeness would license `sync.ts` to
         * withdraw every event beyond page one. Until pagination is
         * implemented AND verified against a real key, the safe answer is that
         * this is a partial view.
         */
        complete: false,
        note: `api ${events.length} events (first page only)`,
      };
    } catch (error) {
      return { ok: false, reason: (error as Error)?.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * One entry from Luma's JSON, defensively.
 *
 * Every field is checked rather than assumed, because this code path has never
 * run against a real response and a wrong assumption here would write nonsense
 * into the staging table rather than fail loudly.
 */
export function normalizeLumaApiEntry(entry: unknown): NormalizedEvent | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const event = (record.event ?? record) as Record<string, unknown>;

  const externalId = typeof event.api_id === 'string' ? event.api_id : null;
  const title = typeof event.name === 'string' ? event.name : null;
  const startRaw = typeof event.start_at === 'string' ? event.start_at : null;
  if (!externalId || !title || !startRaw) return null;

  const startsAt = new Date(startRaw);
  if (Number.isNaN(startsAt.getTime())) return null;

  const endRaw = typeof event.end_at === 'string' ? event.end_at : null;
  const endsAt = endRaw ? new Date(endRaw) : undefined;

  const geo = (event.geo_address_json ?? {}) as Record<string, unknown>;
  const asNumber = (value: unknown): number | undefined => {
    const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

  return {
    externalId,
    title,
    description: asString(event.description),
    startsAt,
    endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : undefined,
    timezone: asString(event.timezone),
    location: asString(geo.full_address) ?? asString(geo.address) ?? asString(event.geo_address_info),
    country: asString(geo.country),
    latitude: asNumber(event.geo_latitude ?? geo.latitude),
    longitude: asNumber(event.geo_longitude ?? geo.longitude),
    organizer: asString((event.host as Record<string, unknown> | undefined)?.name),
    registrationUrl: asString(event.url)
      ? `https://luma.com/${String(event.url).replace(/^https?:\/\/[^/]+\//, '')}`
      : undefined,
    coverUrl: asString(event.cover_url),
    status: asString(event.visibility) === 'cancelled' ? 'cancelled' : asString(event.status),
  };
}
