/**
 * ATTRIBUTION ON AN OUTGOING REGISTRATION LINK.
 *
 * §26 asks that registration links carry WITH CLAUDE attribution so an
 * organiser can see referral traffic, and — the part that is easy to get wrong
 * — that existing parameters from the source are NOT overwritten.
 *
 * That second requirement is the whole reason this is a function. An organiser
 * who circulated `luma.com/claude-r61u?utm_source=whatsapp` is running their
 * own attribution, and a link that rewrote `utm_source` would silently corrupt
 * their numbers while appearing to work. So: add what is missing, touch
 * nothing that is present.
 *
 * ── WHY IT RETURNS THE INPUT ON FAILURE ──────────────────────────────────
 *
 * A malformed or non-HTTP URL is returned unchanged rather than dropped. The
 * link is the one thing on an event page a visitor genuinely needs; degrading
 * attribution is a cost worth paying to avoid degrading the button.
 */

/** The convention, fixed in one place so every link agrees. §26. */
export const UTM = {
  source: 'withclaude',
  medium: 'event',
  campaign: 'india-community',
} as const;

/**
 * Add attribution to a registration URL without disturbing what is there.
 *
 * Only `http` and `https` are accepted. A `javascript:` or `data:` URL has no
 * business being a registration link and is refused rather than decorated —
 * this value originates in an external feed, so it is untrusted input.
 */
export function withAttribution(
  url: string | null | undefined,
  overrides: Partial<typeof UTM> = {},
): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const params = { ...UTM, ...overrides };

  // `has()` before `set()` — this is the merge-safely rule from §26, and the
  // only line in this file that actually implements it.
  if (!parsed.searchParams.has('utm_source')) parsed.searchParams.set('utm_source', params.source);
  if (!parsed.searchParams.has('utm_medium')) parsed.searchParams.set('utm_medium', params.medium);
  if (!parsed.searchParams.has('utm_campaign')) {
    parsed.searchParams.set('utm_campaign', params.campaign);
  }

  return parsed.toString();
}

/**
 * The href for a "Register on Luma" button.
 *
 * A named wrapper rather than calling `withAttribution` at each of the six
 * render sites, so the convention cannot drift between the homepage, the
 * events index and an event's own page.
 *
 * NOTE ON STRUCTURED DATA: this is for links a PERSON clicks. The JSON-LD
 * `offers.url` deliberately keeps the undecorated URL, because that field is a
 * canonical identifier for the offer and a search engine should not be handed
 * our referral parameters as part of it.
 */
export function registrationLink(url: string | null | undefined): string | null {
  return withAttribution(url);
}
