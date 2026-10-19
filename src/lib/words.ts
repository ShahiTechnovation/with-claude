/** `1 event` / `2 events`. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/**
 * `['a', 'b', 'c']` → `a, b & c`.
 *
 * The credit line style used on the event record: commas between, an
 * ampersand before the last. Kept here so a room is never credited one way in
 * one place and another way somewhere else.
 */
export function listJoin(items: string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} & ${items[items.length - 1]}`;
}

/**
 * `Aniket Sahu` → `AS`: the upper-cased first letter of each of the first two
 * words. The avatar where there is no photo (index card, profile) or none is
 * shown (home people list, event host).
 */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
