import { useId, useRef, useState } from 'react';
import { describeAccountError } from '@/lib/account-fetch';

interface ReportModalProps {
  entityType: 'builder' | 'project' | 'media';
  entityId: string;
}

/**
 * `ReportModal` is mounted with `client:load` directly on `/builders/[slug]`
 * and `/projects/[slug]` — its own React root, not inside the site's one
 * `PrivyProvider` (see `src/lib/account-fetch.ts` for the full explanation).
 *
 * Two consequences, both real bugs, neither previously caught:
 *
 * 1. `authenticated` reads the SDK's default context value, which is
 *    HARD-CODED `false`. So the "Report" button's own gate —
 *    `if (!authenticated) login()` — ran on every single click, for every
 *    visitor, signed in or not.
 * 2. `login()` on that same default context THROWS synchronously
 *    ("You need to wrap your application with the <PrivyProvider>…"), and
 *    nothing here caught it. So clicking "Report" did nothing visible, for
 *    everyone, always — the exact silent-failure signature this session
 *    already found in `SignOutButton`.
 *
 * These pages are public and unauthenticated visitors are expected, so the
 * fix does not try to make `authenticated` correct client-side (that would
 * need the SSR page itself to peek at the session cookie and pass the
 * result down, which is a larger change for a modal that already has a
 * server it can just ask). Instead: always let "Report" open the form, and
 * let the ACTUAL POST — which the server already authenticates from the
 * `privy-token` cookie a same-origin request carries automatically — be the
 * one honest answer to "is this person signed in". A 401 there means
 * genuinely not signed in, and is shown as such rather than swallowed.
 */
export function ReportModal({ entityType, entityId }: ReportModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reason, setReason] = useState<string>('other');
  const [details, setDetails] = useState('');

  // The dialog is closed before this replaces it; focus moves to the notice so
  // keyboard and screen-reader users are not dropped on <body>.
  if (success) {
    return (
      <p className="notice notice--success" role="status" tabIndex={-1} ref={(el) => el?.focus()}>
        Thanks — we've received your report.
      </p>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      // Same-origin, so the browser sends the `privy-token` cookie
      // automatically — no Authorization header needed. Trailing slash to
      // avoid a redirect (`trailingSlash: 'always'`, `astro.config.mjs`).
      const res = await fetch('/api/reports/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType, entityId, reason, details }),
        credentials: 'same-origin',
      });

      if (!res.ok) {
        // 401 here is the real, honest "not signed in" — the one this
        // component previously never reached, because the broken client-side
        // `authenticated` check intercepted every click before the form even
        // opened.
        throw new Error(await describeAccountError(res));
      }

      dialogRef.current?.close();
      setSuccess(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const close = () => dialogRef.current?.close();

  return (
    <>
      <button
        type="button"
        className="button button--quiet"
        onClick={() => dialogRef.current?.showModal()}
        title="Report this content"
      >
        Report
      </button>

      {/* `* { margin: 0 }` in base.css cancels the browser's own centring of a modal dialog.
          Built for the cream ground, so it keeps a light scope on a dark page. */}
      <dialog
        ref={dialogRef}
        className="panel"
        data-theme="light"
        aria-labelledby={`${id}-title`}
        style={{ width: '28rem', margin: 'auto' }}
      >
        <div className="panel-head">
          <h2 id={`${id}-title`}>Report content</h2>
          <button type="button" className="button button--quiet" aria-label="Close" onClick={close}>
            <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-grid">
            {error && (
              <div className="notice notice--error" role="alert">
                {error}
              </div>
            )}

            <div className="form-field">
              <label className="field-label" htmlFor={`${id}-reason`}>
                Why are you reporting this?
              </label>
              <select
                id={`${id}-reason`}
                className="input"
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                <option value="spam">Spam or misleading</option>
                <option value="impersonation">Impersonation</option>
                <option value="harassment">Harassment or abusive</option>
                <option value="inappropriate_content">Inappropriate content</option>
                <option value="stolen_work">Stolen work</option>
                <option value="unsafe_link">Unsafe links</option>
                <option value="copyright">Copyright violation</option>
                <option value="privacy">Privacy violation</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div className="form-field">
              <label className="field-label" htmlFor={`${id}-details`}>
                Tell us more <span className="field-tag">optional</span>
              </label>
              <textarea
                id={`${id}-details`}
                className="input"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                rows={3}
                placeholder="Any additional details..."
              />
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="button button--primary" disabled={isSubmitting}>
              {isSubmitting ? 'Submitting...' : 'Submit report'}
            </button>
            <button type="button" className="button button--quiet" onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
