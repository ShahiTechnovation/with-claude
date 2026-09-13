/**
 * AN iCALENDAR PARSER, NARROWED TO WHAT A FEED ACTUALLY SENDS.
 *
 * RFC 5545 is a large specification and this is not an implementation of it.
 * It reads a published calendar: `VEVENT` components with single-value
 * properties, which is what Luma emits and what every hosted calendar emits.
 * It does not do recurrence (`RRULE`), alarms, free/busy, journals or todos.
 *
 * ── WHY NOT A LIBRARY ────────────────────────────────────────────────────
 *
 * Because the two hard parts of this file are not parsing. They are line
 * unfolding and text unescaping, which are about forty lines together, and
 * every calendar library that does them also brings a timezone database and a
 * recurrence engine this project has no use for. §0 freezes the dependency
 * list; adding one to avoid forty lines is the wrong trade, and a dependency
 * that silently drops `GEO` would cost more to discover than to replace.
 *
 * ── THE TWO THINGS THAT ARE EASY TO GET WRONG ────────────────────────────
 *
 * 1. FOLDING. RFC 5545 §3.1 says a line longer than 75 octets is split, and
 *    continuation lines begin with a single space or tab. So a `DESCRIPTION`
 *    arrives across a dozen physical lines, and a parser that reads the file
 *    line-by-line sees a dozen properties it does not recognise and silently
 *    loses the address. Unfolding MUST happen before anything else looks at a
 *    line — which is why it is the first statement in `parseIcs()` and not a
 *    step inside the property loop. Verified against the real feed: without
 *    it, `LOCATION` appears zero times in 317 events.
 *
 * 2. ESCAPING. `\n` in a property value is a newline, `\,` is a comma, `\;`
 *    is a semicolon and `\\` is a backslash. Unescaping in the wrong order —
 *    backslash last — turns `\\n` into a newline instead of a literal
 *    backslash followed by an n. `unescapeText()` walks the string once for
 *    exactly that reason rather than chaining four `.replace()` calls.
 */

/** One parsed property: its value, and any parameters it carried. */
export interface IcsProperty {
  value: string;
  params: Record<string, string>;
}

/** One `VEVENT`, as properties. Repeated properties keep the first occurrence. */
export type IcsEvent = Record<string, IcsProperty>;

export interface IcsCalendar {
  /** `X-WR-CALNAME`, when the feed names itself. */
  name?: string;
  /** `REFRESH-INTERVAL` / `X-PUBLISHED-TTL`, verbatim — e.g. `PT12H`. */
  refreshInterval?: string;
  events: IcsEvent[];
}

/**
 * Undo RFC 5545 line folding.
 *
 * A CRLF (or LF) followed by one space or tab is a continuation and the break
 * disappears entirely. Nothing else about the line is touched.
 */
export function unfold(raw: string): string {
  return raw.replace(/\r?\n[ \t]/g, '');
}

/**
 * Decode an escaped iCalendar text value.
 *
 * One pass, left to right, so an escaped backslash cannot be re-read as the
 * start of another escape. `\N` is the same as `\n` per §3.3.11.
 */
export function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    i += 1;
    switch (next) {
      case 'n':
      case 'N':
        out += '\n';
        break;
      case ',':
        out += ',';
        break;
      case ';':
        out += ';';
        break;
      case '\\':
        out += '\\';
        break;
      default:
        // Not a defined escape. Keep both characters rather than eat one —
        // losing input is worse than passing an oddity through.
        out += `\\${next}`;
    }
  }
  return out;
}

/**
 * Split one unfolded content line into name, parameters and value.
 *
 * The grammar is `NAME;PARAM=VALUE;PARAM="quoted value":VALUE`. The first
 * unquoted colon ends the name-and-parameters section — quoted, because
 * `ORGANIZER;CN="Xavier (최훈민)":MAILTO:…` has a colon inside the value and
 * two more after it, and splitting on the first colon found anywhere would cut
 * a parameter in half.
 */
export function parseLine(line: string): { name: string; property: IcsProperty } | null {
  let colon = -1;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  // Parameters are semicolon-separated, and a quoted parameter value may
  // itself contain a semicolon.
  const segments: string[] = [];
  let current = '';
  quoted = false;
  for (const char of head) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ';' && !quoted) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);

  const name = (segments.shift() ?? '').trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const segment of segments) {
    const equals = segment.indexOf('=');
    if (equals <= 0) continue;
    params[segment.slice(0, equals).trim().toUpperCase()] = segment.slice(equals + 1).trim();
  }

  return { name, property: { value, params } };
}

/**
 * Parse a published calendar.
 *
 * Unknown components are skipped rather than rejected: a feed that starts
 * emitting `VTIMEZONE` must not stop this from reading its events.
 */
export function parseIcs(raw: string): IcsCalendar {
  const lines = unfold(raw).split(/\r?\n/);

  const calendar: IcsCalendar = { events: [] };
  let current: IcsEvent | null = null;
  // Depth of components we are inside but do not care about, so a property
  // from a nested VALARM is never mistaken for one of its event's.
  let skipping = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = parseLine(trimmed);
    if (!parsed) continue;
    const { name, property } = parsed;

    if (name === 'BEGIN') {
      const component = property.value.trim().toUpperCase();
      if (component === 'VEVENT' && skipping === 0) current = {};
      else if (component !== 'VCALENDAR') skipping += 1;
      continue;
    }

    if (name === 'END') {
      const component = property.value.trim().toUpperCase();
      if (component === 'VEVENT' && skipping === 0) {
        if (current) calendar.events.push(current);
        current = null;
      } else if (component !== 'VCALENDAR' && skipping > 0) {
        skipping -= 1;
      }
      continue;
    }

    if (skipping > 0) continue;

    if (current) {
      // First occurrence wins. A published feed does not repeat these, and
      // picking the first is at least deterministic if one ever does.
      if (!(name in current)) current[name] = property;
      continue;
    }

    if (name === 'X-WR-CALNAME') calendar.name = unescapeText(property.value).trim();
    if (name === 'REFRESH-INTERVAL' || name === 'X-PUBLISHED-TTL') {
      calendar.refreshInterval ??= property.value.trim();
    }
  }

  return calendar;
}

/** A property value, unescaped and trimmed, or undefined if absent or empty. */
export function text(event: IcsEvent, name: string): string | undefined {
  const raw = event[name]?.value;
  if (raw === undefined) return undefined;
  const value = unescapeText(raw).trim();
  return value === '' ? undefined : value;
}

/**
 * An iCalendar date-time as a real instant.
 *
 * Three forms appear in the wild:
 *
 *   `20251009T161500Z`  UTC, and the only unambiguous one.
 *   `20251009T161500`   local to the `TZID` parameter, or floating if none.
 *   `20251009`          a date, for an all-day event.
 *
 * ── THE HONEST LIMIT ─────────────────────────────────────────────────────
 *
 * A `TZID` cannot be resolved to an offset without a timezone database, and
 * §0 rules out adding one. So a non-UTC value is read AS IF UTC and the zone
 * is returned alongside it, unresolved, for the caller to record. That is a
 * real inaccuracy and it is deliberately not hidden: `zone` being set while
 * `utc` is false is the signal that the instant is approximate.
 *
 * It costs nothing on the feed this actually runs against — all 317 Luma
 * events carry `Z` — and it is the reason `assertPublishable`-style
 * promotion refuses to invent a display time it does not trust.
 */
export interface IcsInstant {
  date: Date;
  /** True when the source gave an absolute UTC instant. */
  utc: boolean;
  /** True for a date-only value, which has no time of day at all. */
  dateOnly: boolean;
  /** The declared `TZID`, when there was one and it was not UTC. */
  zone?: string;
}

export function parseIcsDate(property: IcsProperty | undefined): IcsInstant | null {
  if (!property) return null;
  const value = property.value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    return Number.isNaN(date.getTime()) ? null : { date, utc: false, dateOnly: true };
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!dateTime) return null;
  const [, y, m, d, hh, mm, ss, z] = dateTime;

  const date = new Date(
    Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)),
  );
  if (Number.isNaN(date.getTime())) return null;

  const utc = z === 'Z';
  const tzid = property.params.TZID;
  return {
    date,
    utc,
    dateOnly: false,
    zone: utc ? undefined : tzid && tzid.toUpperCase() !== 'UTC' ? tzid : undefined,
  };
}
