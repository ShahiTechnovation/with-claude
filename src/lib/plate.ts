import type { CityStatus } from '@/data/types';

/**
 * The shape the survey plate serialises for its readout island.
 *
 * It lives here rather than inside the component's client `<script>` so the
 * server-side render and the browser code agree on one definition — and so the
 * script block stays plain enough for the formatter to parse.
 */
export interface ReadoutCity {
  slug: string;
  name: string;
  state: string;
  status: CityStatus;
  coords: string;
  blurb: string;
  events: number;
  organiser: string | null;
  next: { title: string; date: string; slug: string } | null;
}
