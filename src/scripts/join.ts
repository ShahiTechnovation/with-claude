/**
 * The join flow.
 *
 * Three answers in, a handful of real links out. Nothing is stored, sent, or
 * remembered — the answers live in three local variables and die with the page.
 * That is deliberate: a community entry flow should not be a lead form.
 *
 * Every destination it can produce also exists as a link further down the same
 * page, so the island is genuinely an accelerator rather than a gate.
 */
interface JoinCity {
  slug: string;
  name: string;
  region: string;
  live: boolean;
  stateLabel: string;
  next: { title: string; slug: string; date: string } | null;
}

interface JoinData {
  cities: JoinCity[];
  next: { title: string; slug: string; city: string; date: string } | null;
}

interface Suggestion {
  href: string;
  title: string;
  why: string;
}

function initJoin(root: HTMLElement): void {
  const raw = root.querySelector<HTMLScriptElement>('[data-join-data]');
  const citySelect = root.querySelector<HTMLSelectElement>('[data-join-city]');
  const result = root.querySelector<HTMLElement>('[data-join-result]');
  const list = root.querySelector<HTMLElement>('[data-join-links]');
  if (!raw || !citySelect || !result || !list) return;

  const data: JoinData = JSON.parse(raw.textContent ?? '{"cities":[],"next":null}');
  const bySlug = new Map(data.cities.map((city) => [city.slug, city]));

  let build = '';
  let want = '';

  const suggest = (): Suggestion[] => {
    const city = bySlug.get(citySelect.value);
    const out: Suggestion[] = [];

    // Where you are decides the first card, always.
    if (city?.live) {
      out.push({
        href: `/cities/${city.slug}`,
        title: `${city.name} is active`,
        why: `${city.stateLabel} — events, builders and projects in one place`,
      });
      if (city.next) {
        out.push({
          href: `/events/${city.next.slug}`,
          title: city.next.title,
          why: `${city.next.date} in ${city.name}`,
        });
      }
    } else if (city) {
      out.push({
        href: '/join#city',
        title: `Register ${city.name}`,
        why: 'Nothing verified there yet — this records that you are',
      });
      if (data.next) {
        out.push({
          href: `/events/${data.next.slug}`,
          title: data.next.title,
          why: `${data.next.date} in ${data.next.city} — the next one anywhere`,
        });
      }
    } else if (citySelect.value === 'elsewhere') {
      out.push({
        href: '/join#city',
        title: 'Register your city',
        why: 'It is not on the map yet — put it there',
      });
    }

    // What you are looking for decides the rest.
    if (want === 'attend') {
      out.push({ href: '/events', title: 'Every event', why: 'Past and upcoming, filterable' });
    }
    if (want === 'people') {
      out.push({
        href: '/builders',
        title: 'The builder index',
        why: 'Who is building, and where',
      });
      out.push({
        href: '/join#contribute',
        title: 'Add yourself',
        why: 'Being findable is how people find you',
      });
    }
    if (want === 'show') {
      out.push({
        href: '/join#build',
        title: 'Submit your build',
        why: 'Reviewed, then published in the archive',
      });
      out.push({ href: '/projects', title: 'The archive', why: 'What is already in it' });
    }
    if (want === 'help') {
      out.push({
        href: 'https://tally.so/r/D46gXj',
        title: 'Volunteer',
        why: 'Check-in, stage, photographs',
      });
      out.push({
        href: 'https://tally.so/r/Y5lNo6',
        title: 'Speak or mentor',
        why: 'Run a session or walk a room through something',
      });
      out.push({
        href: '/community#ambassador',
        title: 'Host Claude Community events',
        why: "That means Anthropic's Ambassador programme, not this site",
      });
    }

    // What you build only narrows things where it genuinely changes the answer.
    if (build === 'student') {
      out.push({
        href: '/events',
        title: 'Campus sessions',
        why: 'Filter the record by format',
      });
    }
    if (build === 'exploring' && want !== 'attend') {
      out.push({
        href: '/stories',
        title: 'From the community',
        why: 'What these rooms actually look like',
      });
    }

    // De-duplicate, keeping first appearance.
    const seen = new Set<string>();
    return out.filter((item) => (seen.has(item.href) ? false : seen.add(item.href)));
  };

  const render = () => {
    const items = suggest();
    if (!items.length) {
      result.hidden = true;
      return;
    }

    list.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = item.href;
        if (item.href.startsWith('http')) {
          a.target = '_blank';
          a.rel = 'noopener';
        }

        const title = document.createElement('span');
        title.className = 'result-title';
        title.textContent = item.title;

        const why = document.createElement('span');
        why.className = 'result-why';
        why.textContent = item.why;

        const arrow = document.createElement('span');
        arrow.className = 'result-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = item.href.startsWith('http') ? '↗' : '→';

        a.append(title, why, arrow);
        li.append(a);
        return li;
      }),
    );

    result.hidden = false;
  };

  citySelect.addEventListener('change', render);

  root.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('.choice');
    if (!button) return;

    const group = button.dataset.joinBuild ? 'build' : button.dataset.joinWant ? 'want' : null;
    if (!group) return;

    const value = button.dataset.joinBuild ?? button.dataset.joinWant ?? '';
    const current = group === 'build' ? build : want;
    const nextValue = current === value ? '' : value;

    if (group === 'build') build = nextValue;
    else want = nextValue;

    const attr = group === 'build' ? 'data-join-build' : 'data-join-want';
    root.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((other) => {
      other.setAttribute('aria-pressed', String(other === button && nextValue !== ''));
    });

    render();
  });
}

document.querySelectorAll<HTMLElement>('[data-join-flow]').forEach(initJoin);
