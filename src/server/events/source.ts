/**
 * WHAT AN EVENT SOURCE IS, AND WHAT IT IS NOT ALLOWED TO KNOW.
 *
 * §17 asks for an abstraction over Luma's API, Luma's public iCal feed, and
 * manual entry. This is that seam, and its shape is chosen so the honest
 * fallback and the privileged API are genuinely interchangeable rather than
 * nominally so.
 *
 * A source's ENTIRE job is: go and get events, and hand back
 * `NormalizedEvent[]`. It does not classify, it does not resolve a city, it
 * does not decide what is publishable, it does not touch the database, and it
 * does not know that India exists. All of that is `sync.ts`, once, for every
 * source — because the moment two sources each own their own classification,
 * "the India filter" stops being a thing that can be tested and becomes two
 * things that drift.
 *
 * The same argument `src/data/source.ts` makes about `RecordSet`: put the seam
 * as low as it will go, and let one implementation of the interesting logic
 * sit above it.
 *
 * ── WHY `fetched` IS A RESULT AND NOT A THROW ────────────────────────────
 *
 * Because a feed being unreachable is an ordinary Tuesday, not an exception.
 * A cron run that cannot reach Luma must record `failed` against the source
 * and leave every existing event exactly as it was — and in particular must
 * NOT conclude that 317 events have been cancelled because a fetch timed out.
 * Returning a typed failure makes that the easy path; throwing would make the
 * caller responsible for remembering, which is how that bug gets written.
 *
 * That distinction is the whole reason `complete` exists. See `sync.ts`.
 */

/**
 * One external event, in the shape the sync understands.
 *
 * Every field is what the SOURCE said. Nothing here is normalised toward what
 * the site wants to display, because a source that starts editorialising is a
 * source whose output cannot be compared against the feed it came from.
 */
export interface NormalizedEvent {
  /**
   * The provider's stable identifier for this event.
   *
   * MUST be stable across syncs — it is half of the `(source_id, external_id)`
   * uniqueness constraint, and therefore the entire basis of deduplication. A
   * source that returns a fresh id each run produces duplicates on every run,
   * which is the failure §43 exists to prevent.
   */
  externalId: string;

  title: string;
  description?: string;

  startsAt: Date;
  endsAt?: Date;
  /** An IANA zone, only if the source actually names one. Never guessed. */
  timezone?: string;

  /** The address as given. May be a URL when a venue is registrant-only. */
  location?: string;
  country?: string;
  latitude?: number;
  longitude?: number;

  organizer?: string;
  /** Where a human goes to register. UTM is added later, not here. */
  registrationUrl?: string;
  coverUrl?: string;

  /** The source's own revision counter, where it has one. */
  sequence?: number;
  /**
   * The source's own status string, verbatim.
   *
   * Not an enum, because the point is to record what the source said rather
   * than to launder it into our vocabulary. `sync.ts` decides what counts as
   * cancelled — see `isCancelledStatus()`.
   */
  status?: string;
}

export type FetchResult =
  | {
      ok: true;
      events: NormalizedEvent[];
      /**
       * TRUE ONLY IF THIS IS THE WHOLE CALENDAR.
       *
       * The single most dangerous boolean in the ingestion path. `sync.ts`
       * treats an event that is in the database but absent from a COMPLETE
       * fetch as withdrawn — which for the Claude Community feed is the only
       * cancellation signal that exists, since it reports `TENTATIVE` on every
       * event it has.
       *
       * So a partial or paginated fetch, or a webhook delivering one event,
       * MUST set this false. A source that sets it true when it has only some
       * of the calendar will cancel everything it did not mention.
       */
      complete: boolean;
      /** A safe note for `event_sources.last_sync_message`. Never a secret. */
      note?: string;
    }
  | {
      ok: false;
      /** A fixed code. Never an SDK error, never a URL that might carry a key. */
      reason: string;
    };

export interface EventSource {
  /** Stable handle, e.g. `luma:claudecommunity`. Matches `event_sources.key`. */
  readonly key: string;
  readonly provider: string;
  readonly label: string;
  /**
   * How this source is actually polled.
   *
   * Reported rather than assumed, so §56 can be honoured: the site says
   * "scheduled sync" for `ics` and "near-real-time" for `webhook` because it
   * reads this, not because somebody wrote a claim into a template.
   */
  readonly syncMode: 'api' | 'webhook' | 'ics' | 'manual';
  /** The provider's calendar identifier, when it has one. Public, never a key. */
  readonly calendarId?: string;
  /** The public feed URL, when there is one. Never carries a credential. */
  readonly feedUrl?: string;

  fetch(): Promise<FetchResult>;
}

/**
 * Which source statuses mean "this is off".
 *
 * iCalendar defines `CANCELLED`; Luma's API uses its own words. Kept in one
 * function so §23 has a single place to be right.
 *
 * NOTE ON `TENTATIVE`: it is NOT cancellation. The Claude Community feed marks
 * all 317 of its events tentative, including ones that definitely happened, so
 * treating it as cancelled would empty the directory.
 */
export function isCancelledStatus(status: string | undefined | null): boolean {
  if (!status) return false;
  const value = status.trim().toLowerCase();
  return value === 'cancelled' || value === 'canceled' || value === 'declined';
}
