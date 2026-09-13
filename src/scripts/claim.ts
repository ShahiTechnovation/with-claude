/**
 * The "Claim this profile" button.
 *
 * Lives in the shared enhancement bundle rather than being a page-level
 * script, because the control appears on 72 prerendered pages and giving each
 * of them its own module would be 72 extra requests to do one thing.
 *
 * ── THE ANONYMOUS PATH ───────────────────────────────────────────────────
 *
 * The page is on a CDN and cannot know who is reading it, so the button is
 * rendered the same for everybody. Pressing it while signed out sends the
 * visitor to their authenticated profile route, where the sitewide Privy gate
 * opens the sign-in modal without routing through a second onboarding page.
 *
 * The signed-out case is detected the same cheap way the account menu uses:
 * Privy's readable session marker. A false negative just means a redirect
 * through the authenticated profile route, which verifies the session.
 */

/** Trailing slash deliberate — see `src/data/forms.ts`. */
const CLAIM_ENDPOINT = '/api/member/claim/';

interface ClaimResponse {
  status?: 'approved' | 'pending';
  message?: string;
  error?: string;
  url?: string;
}

function signedIn(): boolean {
  return /(?:^|;\s*)privy-session=/.test(document.cookie);
}

export function claim(): void {
  const panel = document.querySelector<HTMLElement>('[data-claim]');
  if (!panel) return;

  const button = panel.querySelector<HTMLButtonElement>('[data-claim-button]');
  const status = panel.querySelector<HTMLElement>('[data-claim-status]');
  const slug = panel.dataset.claimSlug;
  if (!button || !status || !slug) return;

  button.addEventListener('click', () => {
    if (!signedIn()) {
      window.location.assign('/me/profile/');
      return;
    }

    button.disabled = true;
    status.textContent = 'Checking…';

    void fetch(CLAIM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ slug }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as ClaimResponse;

        if (!response.ok) {
          status.textContent = body.error ?? 'That could not be checked right now.';
          button.disabled = false;
          return;
        }

        // Both outcomes are successes and both are stated plainly — an
        // approved claim says the edits are not visible yet, because the page
        // is prerendered and that is true.
        status.textContent = body.message ?? 'Done.';
        button.remove();
      })
      .catch(() => {
        status.textContent = 'Could not reach the server. Try again.';
        button.disabled = false;
      });
  });
}
