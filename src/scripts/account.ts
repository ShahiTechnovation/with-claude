/**
 * THE ACCOUNT MENU — the whole auth-aware UI on 72 static pages, in vanilla TS.
 *
 * ── WHY THIS IS NOT A REACT ISLAND ───────────────────────────────────────
 *
 * Because it appears on every page, and Privy's React SDK is around 150 KB.
 * Paying that on the homepage, on every builder profile and on every archived
 * event page — to render an avatar and a handle — would undo the thing that
 * makes this site good. §22 says the public archive stays fast, and the
 * cheapest way to keep a promise like that is to make the expensive thing
 * impossible to import here.
 *
 * So the split is:
 *
 *   /join, /me/*     React + Privy SDK, because there is a login UI
 *   everywhere else  this file, one fetch, no framework
 *
 * ── WHY IT IS A FETCH AND NOT SERVER-RENDERED ────────────────────────────
 *
 * Because the pages are files on a CDN. A static page cannot know who is
 * asking — that is what makes it cacheable, and it is the property worth
 * keeping. The HTML therefore ships the anonymous state, which is correct for
 * a shared cache, and this upgrades it in place for the small minority of
 * visitors who are signed in.
 *
 * The failure mode is deliberate: if the fetch fails, times out, or the person
 * is not signed in, the "Join WITH CLAUDE" link that was already in the HTML
 * simply stays. Nothing disappears and nothing shifts, because the anonymous
 * markup is the fallback rather than a placeholder.
 */

interface MemberSummary {
  status: string;
  profile: {
    username: string;
    needsUsername: boolean;
    displayName: string | null;
  };
  builder: { slug: string; name: string } | null;
}

/** The masthead slot, rendered anonymous by `AccountNav.astro`. */
const MOUNT = '[data-account]';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '·';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Replace the anonymous slot with the signed-in one.
 *
 * Everything is created with `textContent` and `setAttribute`, never with
 * `innerHTML`. The values are a display name and a handle that the member
 * typed themselves — the exact profile of an XSS payload — and while the
 * server escapes them on render, a client-side template string would be a
 * second, unescaped path to the same page. There is no reason to have one.
 */
function render(slot: HTMLElement, me: MemberSummary): void {
  const label = me.profile.displayName?.trim() || me.profile.username;
  const href = me.profile.needsUsername ? '/me/profile/edit/' : '/me/';

  const link = document.createElement('a');
  link.className = 'account-link';
  link.setAttribute('href', href);
  link.setAttribute('data-account-signed-in', '');

  const badge = document.createElement('span');
  badge.className = 'account-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = initials(label);

  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = label;

  link.append(badge, name);
  link.setAttribute('aria-label', `Your account — ${label}`);

  slot.replaceChildren(link);
  slot.setAttribute('data-account-state', 'signed-in');
}

export function account(): void {
  const slot = document.querySelector<HTMLElement>(MOUNT);
  if (!slot) return;

  /**
   * Only ask if there is a plausible session.
   *
   * `privy-token` is HttpOnly, so this cannot read it — but Privy also sets a
   * readable `privy-session` marker when a session exists. Checking it first
   * means an anonymous visitor, who is most visitors, makes NO request at all:
   * no function invocation, no database query, nothing to rate-limit. If the
   * marker is absent we simply leave the anonymous markup alone.
   *
   * A false negative is harmless — the person sees "Join" and clicking it
   * signs them straight in, because Privy still has the session.
   */
  if (!/(?:^|;\s*)privy-session=/.test(document.cookie)) return;

  const controller = new AbortController();
  // A masthead must never be the reason a page feels slow.
  const timeout = window.setTimeout(() => controller.abort(), 4000);

  fetch('/api/member/me', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((me: MemberSummary | null) => {
      if (me && me.status === 'active') render(slot, me);
    })
    .catch(() => {
      /* Anonymous markup stays. Nothing to report to the visitor. */
    })
    .finally(() => window.clearTimeout(timeout));
}
