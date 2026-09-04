import type { AtlasCity } from '@/lib/atlas';

/**
 * The atlas island.
 *
 * Everything here is additive. With scripts blocked the plate is a legible
 * drawing, every node is a real link to a city page, and the readout is
 * server-rendered with a correct resting state.
 *
 * Pointer behaviour differs deliberately by input:
 *
 *  · Fine pointer — hover or focus previews a city, leaving the plate settles
 *    back. Clicking navigates, as a link should.
 *  · Coarse pointer — the first tap on a map node previews it and the second
 *    navigates, because a fingertip has no hover to preview with. The city
 *    list beside the plate is unaffected: those are ordinary rows with
 *    ordinary targets, and one tap opens them.
 */
function initAtlas(svg: SVGSVGElement): void {
  const id = svg.dataset.atlas;
  if (!id) return;

  const root = svg.closest<HTMLElement>('.atlas');
  const panel = document.querySelector<HTMLElement>(`[data-readout="${id}"]`);
  const raw = document.querySelector<HTMLScriptElement>(`[data-atlas-data="${id}"]`);
  if (!root || !panel || !raw) return;

  const cities: AtlasCity[] = JSON.parse(raw.textContent ?? '[]');
  const bySlug = new Map(cities.map((city) => [city.slug, city]));
  const resting = cities[0];
  if (!resting) return;

  const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const pad = (n: number) => String(n).padStart(2, '0');

  const field = (name: string) => panel.querySelector<HTMLElement>(`[data-readout-${name}]`);
  const el = {
    name: field('name'),
    region: field('region'),
    coords: field('coords'),
    chip: field('chip'),
    state: field('state'),
    note: field('note'),
    events: field('events'),
    builders: field('builders'),
    projects: field('projects'),
    next: field('next'),
    linkLabel: field('link-label'),
    link: panel.querySelector<HTMLAnchorElement>('[data-readout-link]'),
  };

  let selected = resting.slug;

  const render = (city: AtlasCity | undefined) => {
    if (!city) return;
    selected = city.slug;

    if (el.name) el.name.textContent = city.name;
    if (el.region) el.region.textContent = city.region;
    if (el.coords) el.coords.textContent = city.coords;
    if (el.note) el.note.textContent = city.note;
    if (el.state) el.state.textContent = city.stateLabel;
    if (el.events) el.events.textContent = pad(city.events);
    if (el.builders) el.builders.textContent = pad(city.builders);
    if (el.projects) el.projects.textContent = pad(city.projects);
    if (el.next) {
      el.next.textContent = city.next ? `Next: ${city.next.date} — ${city.next.title}` : '';
    }
    if (el.chip) {
      // The chip's class carries the state, so swap the whole modifier.
      const previous = el.chip.dataset.state;
      if (previous) el.chip.classList.remove(`chip-${previous}`);
      el.chip.classList.add(`chip-${city.state}`);
      el.chip.dataset.state = city.state;
    }
    if (el.link) el.link.href = `/cities/${city.slug}`;
    if (el.linkLabel) el.linkLabel.textContent = `Open ${city.name}`;

    root.querySelectorAll<HTMLElement>('[data-node]').forEach((node) => {
      node.classList.toggle('is-selected', node.dataset.node === city.slug);
    });
  };

  render(resting);

  const nodeFrom = (event: Event): HTMLElement | null =>
    (event.target as Element | null)?.closest<HTMLElement>('[data-node]') ?? null;

  /**
   * Tell the scout where the city is, in page coordinates.
   *
   * A custom event rather than an import: the scout is its own island and
   * neither of these two has to exist for the other to work. The plate node
   * is measured rather than the row, so the scout turns toward the point on
   * the map even when the list drove the change.
   */
  const pointAt = (slug: string) => {
    const mark = svg.querySelector<SVGGraphicsElement>(`[data-node="${CSS.escape(slug)}"]`);
    if (!mark) return;
    const box = mark.getBoundingClientRect();
    document.dispatchEvent(
      new CustomEvent('scout:look', {
        detail: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      }),
    );
  };

  const release = () => document.dispatchEvent(new CustomEvent('scout:release'));

  const preview = (event: Event) => {
    const slug = nodeFrom(event)?.dataset.node;
    if (!slug) return;
    render(bySlug.get(slug));
    pointAt(slug);
  };

  if (canHover) {
    root.addEventListener('pointerover', preview);
    svg.addEventListener('pointerleave', () => {
      render(resting);
      release();
    });
  } else {
    // First tap previews, second tap opens. Only on the plate — the list rows
    // are ordinary links and must stay one-tap.
    svg.addEventListener('click', (event) => {
      const node = nodeFrom(event);
      const slug = node?.dataset.node;
      if (!slug || slug === selected) return;
      event.preventDefault();
      render(bySlug.get(slug));
    });
  }

  // Leaving the whole instrument — plate or list — lets the scout go. The
  // plate's own leave handler above also resets the readout; this one does
  // not, so a city previewed from the list stays on the panel.
  root.addEventListener('pointerleave', release);

  // Focus always previews, for keyboard users on any input device.
  root.addEventListener('focusin', preview);
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) release();
  });
}

document.querySelectorAll<SVGSVGElement>('[data-atlas]').forEach(initAtlas);
