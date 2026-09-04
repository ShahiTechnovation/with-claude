/**
 * Small number-to-words helper.
 *
 * Headlines read better with "Thirteen" than with "13" — but a headline that
 * hard-codes a count silently goes wrong the moment a city is added. So the
 * prose spells the number out from the same data the map plots.
 */
const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
] as const;

/** `13` → `thirteen`. Falls back to digits above twenty. */
export function inWords(n: number): string {
  return WORDS[n] ?? String(n);
}

/** Sentence-leading form: `13` → `Thirteen`. */
export function inWordsCap(n: number): string {
  const word = inWords(n);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

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
