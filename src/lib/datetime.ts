import type { ClockTime, IsoDate } from '@/data/types';

/** Every event on this site happens in India. IST is UTC+05:30, no DST. */
export const IST_OFFSET = '+05:30';

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Build an absolute instant from an IST calendar date and wall-clock time.
 * Pinning the offset means the result is identical on a laptop in Bhopal and
 * on a build server in Virginia.
 */
export function istInstant(date: IsoDate, time: ClockTime = '00:00'): Date {
  return new Date(`${date}T${time}:00${IST_OFFSET}`);
}

/** The IST calendar day of an instant, as `YYYY-MM-DD`. */
export function istDay(instant: Date): string {
  // Shift into IST, then read the UTC fields — avoids Intl in a hot path.
  const shifted = new Date(instant.getTime() + 5.5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

interface DateParts {
  day: number;
  /** Two-digit day, e.g. `04`. */
  dayPadded: string;
  monthShort: string;
  /** Uppercase three-letter month, for poster-scale display. */
  monthDisplay: string;
  weekdayShort: string;
  year: number;
}

export function dateParts(date: IsoDate): DateParts {
  const d = istInstant(date);
  const shifted = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const day = shifted.getUTCDate();
  const month = MONTHS_SHORT[shifted.getUTCMonth()]!;
  return {
    day,
    dayPadded: String(day).padStart(2, '0'),
    monthShort: month,
    monthDisplay: month.toUpperCase(),
    weekdayShort: DAYS_SHORT[shifted.getUTCDay()]!,
    year: shifted.getUTCFullYear(),
  };
}

/** `Sat, 12 Sep 2026` */
export function formatDate(date: IsoDate): string {
  const p = dateParts(date);
  return `${p.weekdayShort}, ${p.day} ${p.monthShort} ${p.year}`;
}

/** `6:00 PM` */
export function formatTime(time: ClockTime): string {
  const [hStr, mStr] = time.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** `6:00 – 8:30 PM IST`, collapsing a shared AM/PM suffix. */
export function formatTimeRange(start: ClockTime, end?: ClockTime): string {
  if (!end) return `${formatTime(start)} IST`;
  const a = formatTime(start);
  const b = formatTime(end);
  const aSuffix = a.slice(-2);
  const bSuffix = b.slice(-2);
  const left = aSuffix === bSuffix ? a.slice(0, -3) : a;
  return `${left} – ${b} IST`;
}

/**
 * Whole days from `now` to the start of `date`, in IST.
 * Positive means future, 0 means today, negative means past.
 */
export function daysUntil(date: IsoDate, now: Date = new Date()): number {
  const target = istInstant(date).getTime();
  const today = istInstant(istDay(now) as IsoDate).getTime();
  return Math.round((target - today) / 86_400_000);
}

/** `in 9 days` / `today` / `tomorrow` / `2 weeks ago`. */
export function relativeDay(date: IsoDate, now: Date = new Date()): string {
  const d = daysUntil(date, now);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  if (d > 0) return d < 14 ? `in ${d} days` : `in ${Math.round(d / 7)} weeks`;
  const ago = Math.abs(d);
  if (ago < 14) return `${ago} days ago`;
  if (ago < 60) return `${Math.round(ago / 7)} weeks ago`;
  return `${Math.round(ago / 30)} months ago`;
}

/** Full ISO instant with the IST offset — for `<time datetime>` and JSON-LD. */
export function isoDateTime(date: IsoDate, time: ClockTime = '00:00'): string {
  return `${date}T${time}:00${IST_OFFSET}`;
}
