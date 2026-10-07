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
