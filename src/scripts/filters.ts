/**
 * Archive filters.
 *
 * One generic island, shared by the project archive and the event archive.
 * A filter root contains groups of buttons (`data-filter="city"`,
 * `data-value="pune"`) and a sibling list of `[data-filter-item]` elements
 * carrying matching data attributes.
 *
 * Progressive by construction: the markup renders every item, so with scripts
 * blocked the archive is simply unfiltered rather than broken. Buttons are
 * real buttons, so they are keyboard-operable for free.
 */
function initFilters(root: HTMLElement): void {
  const scope = root.parentElement ?? document;
  const items = Array.from(scope.querySelectorAll<HTMLElement>('[data-filter-item]'));
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-filter]'));
  const counter = root.querySelector<HTMLElement>('[data-filter-count]');
  if (!items.length || !buttons.length) return;

  const active = new Map<string, string>();
  for (const button of buttons) {
    const facet = button.dataset.filter;
    if (facet && !active.has(facet)) active.set(facet, 'all');
  }

  const apply = () => {
    let shown = 0;
    for (const item of items) {
      const match = [...active].every(
        ([facet, value]) => value === 'all' || item.dataset[facet] === value,
      );
      item.hidden = !match;
      if (match) shown += 1;
    }

    for (const button of buttons) {
      const facet = button.dataset.filter;
      button.classList.toggle(
        'is-on',
        Boolean(facet) && active.get(facet!) === button.dataset.value,
      );
      button.setAttribute(
        'aria-pressed',
        String(Boolean(facet) && active.get(facet!) === button.dataset.value),
      );
    }

    if (counter) {
      const total = items.length;
      counter.textContent = shown === total ? `${total} shown` : `${shown} of ${total}`;
    }
  };

  root.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-filter]');
    const facet = button?.dataset.filter;
    const value = button?.dataset.value;
    if (!facet || !value) return;
    // Clicking the live filter again clears it, which is what people expect.
    active.set(facet, active.get(facet) === value && value !== 'all' ? 'all' : value);
    apply();
  });

  apply();
}

document.querySelectorAll<HTMLElement>('[data-filter-root]').forEach(initFilters);
