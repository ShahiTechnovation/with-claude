import type { ReadoutCity } from '@/lib/plate';

/**
 * The survey plate's readout island.
 *
 * Hover *or* focus a city node and the panel beside the map reports on it;
 * leaving the plate settles back to the chapter that actually exists. The
 * panel is server-rendered with that resting state, so this file only ever
 * replaces content that is already correct — with scripts blocked the map is
 * a legible drawing and the panel still reads.
 */
function initPlate(svg: SVGSVGElement): void {
  const id = svg.dataset.plate;
  if (!id) return;

  const panel = document.querySelector<HTMLElement>(`[data-readout="${id}"]`);
  const raw = document.querySelector<HTMLScriptElement>(`[data-readout-data="${id}"]`);
  if (!panel || !raw) return;

  const cities: ReadoutCity[] = JSON.parse(raw.textContent ?? '[]');
  const bySlug = new Map(cities.map((city) => [city.slug, city]));
  const resting = cities.find((city) => city.status === 'active') ?? cities[0];

  const field = (name: string) => panel.querySelector<HTMLElement>(`[data-readout-${name}]`);
  const el = {
    name: field('name'),
    coords: field('coords'),
    status: field('status'),
    blurb: field('blurb'),
    next: field('next'),
    link: panel.querySelector<HTMLAnchorElement>('[data-readout-link]'),
  };

  const statusLine = (city: ReadoutCity) => {
    if (city.status !== 'active') return 'No chapter yet — this one is open';
    const events = `${city.events} event${city.events === 1 ? '' : 's'}`;
    return `Active chapter · ${events}${city.organiser ? ` · ${city.organiser}` : ''}`;
  };

  const render = (city: ReadoutCity | undefined) => {
    if (!city) return;

    if (el.name) el.name.textContent = `${city.name}, ${city.state}`;
    if (el.coords) el.coords.textContent = city.coords;
    if (el.blurb) el.blurb.textContent = city.blurb;
    if (el.next) {
      el.next.textContent = city.next ? `Next: ${city.next.date} — ${city.next.title}` : '';
    }
    if (el.status) {
      el.status.textContent = statusLine(city);
      el.status.dataset.status = city.status;
    }
    if (el.link) {
      el.link.href = `/cities/${city.slug}`;
      const label = el.link.querySelector('span');
      if (label) {
        label.textContent = city.status === 'active' ? `Open ${city.name}` : `About ${city.name}`;
      }
    }
    panel.dataset.status = city.status;

    svg.querySelectorAll<SVGElement>('[data-node]').forEach((node) => {
      node.classList.toggle('is-selected', node.dataset.node === city.slug);
    });
    svg.querySelectorAll<SVGElement>('[data-thread]').forEach((thread) => {
      thread.classList.toggle('is-lit', thread.dataset.thread === city.slug);
    });
  };

  render(resting);

  const select = (event: Event) => {
    const node = (event.target as Element | null)?.closest<SVGElement>('[data-node]');
    if (!node?.dataset.node) return;
    render(bySlug.get(node.dataset.node));
  };

  svg.addEventListener('pointerover', select);
  svg.addEventListener('focusin', select);
  svg.addEventListener('pointerleave', () => render(resting));
}

document.querySelectorAll<SVGSVGElement>('[data-plate]').forEach(initPlate);
