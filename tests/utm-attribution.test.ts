/**
 * §48–§49 — THE CANONICAL ATTRIBUTION VALUE.
 *
 * The value is `withclaude.in`, exactly, everywhere WITH CLAUDE generates a
 * registration link or an embed. It is asserted as a literal string in this
 * file and NOT by importing `UTM.source` into the expectation, which would
 * make the test pass for whatever the constant happened to say. A test that
 * reads the value it is checking cannot catch the bug this file exists for —
 * the constant said `withclaude` for the whole of Phase A.
 */
import { describe, expect, it } from 'vitest';
import { UTM, lumaEmbedAttributes, registrationLink, withAttribution } from '../src/lib/attribution';

const CANONICAL = 'withclaude.in';

describe('the canonical utm_source', () => {
  it('is exactly withclaude.in', () => {
    expect(UTM.source).toBe(CANONICAL);
  });

  it('is not one of the forms §48 rejects', () => {
    for (const wrong of ['withclaude', 'WITHCLAUDE', 'with_claude', 'WithClaude.in']) {
      expect(UTM.source).not.toBe(wrong);
    }
  });

  it('reaches an outgoing registration link', () => {
    const url = new URL(registrationLink('https://luma.com/abc123')!);
    expect(url.searchParams.get('utm_source')).toBe(CANONICAL);
    expect(url.searchParams.get('utm_medium')).toBe('event');
    expect(url.searchParams.get('utm_campaign')).toBe('india-community');
  });

  it('reaches a Luma embed through the attribute Luma reads', () => {
    expect(lumaEmbedAttributes()['data-luma-utm-source']).toBe(CANONICAL);
  });

  it('is the same value on the link and the embed', () => {
    const linked = new URL(registrationLink('https://luma.com/abc123')!);
    expect(lumaEmbedAttributes()['data-luma-utm-source']).toBe(
      linked.searchParams.get('utm_source'),
    );
  });
});

describe('merging with what the URL already carries', () => {
  it('never writes utm_source twice', () => {
    const result = registrationLink('https://luma.com/abc?utm_source=whatsapp')!;
    // `URLSearchParams.getAll` is the only honest check here: a naive
    // `?utm_source=whatsapp&utm_source=withclaude.in` would satisfy
    // `.get()` and `.toContain()` and still be a corrupted link.
    expect(new URL(result).searchParams.getAll('utm_source')).toEqual(['whatsapp']);
  });

  it('preserves an organiser own campaign parameters', () => {
    const result = new URL(
      registrationLink('https://luma.com/abc?utm_source=whatsapp&utm_campaign=diwali&ref=poster')!,
    );
    expect(result.searchParams.get('utm_source')).toBe('whatsapp');
    expect(result.searchParams.get('utm_campaign')).toBe('diwali');
    expect(result.searchParams.get('ref')).toBe('poster');
    // The one parameter that was genuinely absent is the one that gets added.
    expect(result.searchParams.get('utm_medium')).toBe('event');
  });

  it('adds nothing twice when a link is decorated twice', () => {
    const once = registrationLink('https://luma.com/abc')!;
    const twice = registrationLink(once)!;
    expect(twice).toBe(once);
    expect(new URL(twice).searchParams.getAll('utm_source')).toEqual([CANONICAL]);
  });

  it('keeps an existing path, fragment and unrelated query intact', () => {
    const result = new URL(registrationLink('https://luma.com/e/abc?tier=free#agenda')!);
    expect(result.pathname).toBe('/e/abc');
    expect(result.hash).toBe('#agenda');
    expect(result.searchParams.get('tier')).toBe('free');
  });
});

describe('encoding', () => {
  it('encodes the dot-bearing source as a literal dot, not %2E', () => {
    // A dot is an unreserved character in a query value. Percent-encoding it
    // would still parse, but Luma reports the raw string, so `withclaude%2Ein`
    // would show up in an organiser report as a third spelling of the source.
    expect(registrationLink('https://luma.com/abc')).toContain('utm_source=withclaude.in');
    expect(registrationLink('https://luma.com/abc')).not.toContain('%2E');
  });

  it('round-trips through URL parsing unchanged', () => {
    const result = registrationLink('https://luma.com/abc')!;
    expect(new URL(result).toString()).toBe(result);
  });

  it('does not decorate a non-HTTP scheme', () => {
    expect(withAttribution('javascript:alert(1)')).toBeNull();
    expect(withAttribution('data:text/html,<b>')).toBeNull();
  });

  it('returns null for nothing, rather than a bare parameter string', () => {
    expect(registrationLink(null)).toBeNull();
    expect(registrationLink(undefined)).toBeNull();
    expect(registrationLink('   ')).toBeNull();
  });
});
