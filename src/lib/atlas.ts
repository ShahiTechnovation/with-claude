import type { CityState } from '@/data/types';

/**
 * The shape the atlas serialises for its readout island.
 *
 * It lives here rather than inside the component's client `<script>` so the
 * server render and the browser code agree on one definition — and so the
 * script block stays plain enough for the formatter to parse.
 */
export interface AtlasCity {
  slug: string;
  name: string;
  /** The Indian state the city is in. */
  region: string;
  /** The derived community state. */
  state: CityState;
  stateLabel: string;
  /** The one true sentence about this city's status. */
  note: string;
  coords: string;
  blurb: string;
  events: number;
  held: number;
  builders: number;
  projects: number;
  ambassador: string | null;
  next: { title: string; date: string; slug: string } | null;
}
