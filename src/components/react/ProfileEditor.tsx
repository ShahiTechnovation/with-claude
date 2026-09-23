/**
 * PROFILE EDITOR — the Builder Passport form.
 *
 * Two-step save:
 *   PATCH /api/member/profile/  — saves the profile fields
 *   POST  /api/member/profile/  — publishes the builder passport
 *
 * "Save changes" always does a PATCH and stays on the edit page.
 * "Save & publish" does PATCH then POST, then redirects to the public
 * builder page if one was returned, otherwise to /me/profile/.
 *
 * Published state: when `publishedAt` is non-null, the passport is live.
 * The editor shows the publication state and a link to the public profile.
 */
import { useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { cities } from '@/data/cities';
import { SELECTABLE_ROLES } from '@/lib/roles';
import { accountFetch, describeAccountError } from '@/lib/account-fetch';

/**
 * What the edit page actually has to give this component.
 *
 * Deliberately narrower than `ProfileRow` (the server's full row type): this
 * is the second half of the bug that made every save fail. `edit.astro` used
 * to pass `guard.profile` — a `ProfileRow`, which has `cityId`, not
 * `citySlug` — straight through to a prop typed `any`. Nothing caught the
 * mismatch, the city dropdown opened blank regardless of the member's real
 * city, and saving without re-selecting it sent `citySlug: ''`, which the
 * server correctly reads as "clear the city" — a real city, wiped, on a save
 * that never touched that field. Typing this prop explicitly is what makes
 * that mismatch a compile error instead of a silent data loss on the next
 * person who edits this file.
 */
export interface ProfileEditorProfile {
  username: string;
  displayName: string | null;
  citySlug: string;
  primaryRole: string | null;
  headline: string | null;
  bio: string | null;
  claudeSince: string | null;
  website: string | null;
  visibility: string;
  /** ISO string or null — whether the Builder Passport has been published. */
  publishedAt?: string | null;
  /** The public builder slug, if a passport exists. */
  builderSlug?: string | null;
}

export default function ProfileEditor({ profile }: { profile: ProfileEditorProfile }) {
  const { getAccessToken } = usePrivy();
  const [form, setForm] = useState({
    username: profile.username ?? '',
    displayName: profile.displayName ?? '',
    citySlug: profile.citySlug ?? '',
    primaryRole: profile.primaryRole ?? '',
    headline: profile.headline ?? '',
    bio: profile.bio ?? '',
    claudeSince: profile.claudeSince ?? '',
    website: profile.website ?? '',
    visibility: profile.visibility ?? 'public',
  });
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [isPublished, setIsPublished] = useState(Boolean(profile.publishedAt));
  const [builderSlug, setBuilderSlug] = useState(profile.builderSlug ?? null);

  const save = async (publish: boolean = false) => {
    setStatus('saving');
    setMessage('');
    try {
      /**
       * Omit — not send empty — the two fields the schema cannot accept as
       * an empty string.
       */
      const body: Record<string, unknown> = { ...form };
      if (body.primaryRole === '') delete body.primaryRole;
      if (body.website === '') delete body.website;

      const response = await accountFetch(
        '/api/member/profile/',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        getAccessToken,
      );

      if (!response.ok) {
        setStatus('error');
        setMessage(await describeAccountError(response));
        return;
      }

      if (!publish) {
        setStatus('success');
        setMessage('Changes saved.');
        return;
      }

      setStatus('saving');

      const published = await accountFetch(
        '/api/member/profile/',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        getAccessToken,
      );

      if (!published.ok) {
        setStatus('error');
        setMessage(await describeAccountError(published));
        return;
      }

      const pubBody = await published.json().catch(() => ({}));
      setIsPublished(true);
      if (pubBody.builderSlug) setBuilderSlug(pubBody.builderSlug);

      setStatus('success');
      const newSlug = pubBody.builderSlug ?? builderSlug;
      setMessage(
        pubBody.message ||
          (newSlug ? `Published. View at /builders/${newSlug}/` : 'Published.'),
      );

      // Redirect to the public builder page after a short delay.
      if (newSlug) {
        setTimeout(() => {
          window.location.assign(`/builders/${newSlug}/`);
        }, 1200);
      } else {
        setTimeout(() => {
          window.location.assign('/me/profile/');
        }, 1200);
      }
    } catch {
      // Only reachable for an actual network failure — DNS, connection
      // refused, offline — since `accountFetch` no longer lets a missing
      // Privy context surface here as a false "network error".
      setStatus('error');
      setMessage('Network error while saving. Check your connection and try again.');
    }
  };

  return (
    <div className="pe">
      {/* ── Status bar ────────────────────────────────────────────── */}
      <div className="pe-status-bar">
        <span className={`pe-badge ${isPublished ? 'pe-badge--live' : 'pe-badge--draft'}`}>
          {isPublished ? 'Published' : 'Draft'}
        </span>
        {isPublished && builderSlug && (
          <a
            className="pe-public-link"
            href={`/builders/${builderSlug}/`}
            target="_blank"
            rel="noopener"
          >
            View public profile →
          </a>
        )}
      </div>

      {/* ── Fields ────────────────────────────────────────────────── */}
      <div className="pe-grid">
        <label className="pe-label">
          <span>Name</span>
          <input
            className="pe-input"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
        </label>
        <label className="pe-label">
          <span>Username</span>
          <input
            className="pe-input"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </label>
        <label className="pe-label">
          <span>City</span>
          <select
            className="pe-input"
            value={form.citySlug}
            onChange={(e) => setForm({ ...form, citySlug: e.target.value })}
          >
            <option value="">Choose…</option>
            {cities.map((city) => (
              <option key={city.slug} value={city.slug}>
                {city.name}
              </option>
            ))}
          </select>
        </label>
        <label className="pe-label">
          <span>What you do</span>
          {/*
            A `<select>` over the same enum the server validates against —
            see `src/lib/roles.ts`. This used to be a free-text `<input>`
            while the server enforced a closed list, which is the frontend
            and backend disagreeing on STRUCTURE (§6/§7 of the diagnosis):
            not a typo in a field name, but two different shapes for the
            same field.
          */}
          <select value={form.primaryRole} className="pe-input" onChange={(e) => setForm({ ...form, primaryRole: e.target.value })}>
            <option value="">Choose…</option>
            {SELECTABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <label className="pe-label pe-label--wide">
          <span>Headline</span>
          <input
            className="pe-input"
            value={form.headline}
            onChange={(e) => setForm({ ...form, headline: e.target.value })}
            placeholder="One sentence about what you do with Claude."
          />
        </label>
        <label className="pe-label pe-label--wide">
          <span>Bio</span>
          <textarea
            className="pe-input pe-textarea"
            value={form.bio}
            rows={4}
            onChange={(e) => setForm({ ...form, bio: e.target.value })}
          />
        </label>
        <label className="pe-label">
          <span>Claude tools</span>
          <input
            className="pe-input"
            value={form.claudeSince}
            onChange={(e) => setForm({ ...form, claudeSince: e.target.value })}
            placeholder="claude.ai, API, Claude Code…"
          />
        </label>
        <label className="pe-label">
          <span>Website</span>
          <input
            className="pe-input"
            type="url"
            value={form.website}
            onChange={(e) => setForm({ ...form, website: e.target.value })}
            placeholder="https://…"
          />
        </label>
        <label className="pe-label">
          <span>Profile visibility</span>
          <select
            className="pe-input"
            value={form.visibility}
            onChange={(e) => setForm({ ...form, visibility: e.target.value })}
          >
            <option value="public">Public — listed in the builders directory</option>
            <option value="unlisted">Unlisted — accessible by direct link only</option>
          </select>
        </label>
      </div>

      {/* ── Actions ───────────────────────────────────────────────── */}
      <div className="pe-actions">
        <button
          type="button"
          className="pe-btn pe-btn--primary"
          onClick={() => void save(true)}
          disabled={status === 'saving'}
        >
          {status === 'saving'
            ? 'Saving…'
            : isPublished
              ? 'Save & update profile'
              : 'Save & publish profile'}
        </button>
        <button
          type="button"
          className="pe-btn pe-btn--secondary"
          onClick={() => void save(false)}
          disabled={status === 'saving'}
        >
          {status === 'saving' ? 'Saving…' : 'Save changes'}
        </button>
        {message && (
          <p className={`pe-message pe-message--${status}`}>{message}</p>
        )}
      </div>

      <style>{`
        .pe {
          display: flex;
          flex-direction: column;
          gap: 2rem;
          font-family: var(--font-sans);
        }

        /* Status bar */
        .pe-status-bar {
          display: flex;
          align-items: center;
          gap: 1rem;
          flex-wrap: wrap;
        }

        .pe-badge {
          display: inline-flex;
          align-items: center;
          padding: 0.25rem 0.75rem;
          font-family: var(--font-mono);
          font-size: 0.65rem;
          font-weight: 500;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          border-radius: 2px;
          border: 1px solid currentColor;
        }
        .pe-badge--live { color: #166534; border-color: #bbf7d0; background: #f0fdf4; }
        .pe-badge--draft { color: var(--ink-3); border-color: var(--rule); background: var(--paper-sunk, #fafaf9); }

        .pe-public-link {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          color: var(--clay-deep, #92400e);
          text-decoration: none;
          letter-spacing: 0.03em;
        }
        .pe-public-link:hover { text-decoration: underline; }

        /* Grid */
        .pe-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1.25rem;
          padding: 2rem 0;
          border-top: 1px solid var(--rule);
          border-bottom: 1px solid var(--rule);
        }

        @media (max-width: 37.99em) {
          .pe-grid { grid-template-columns: 1fr; }
        }

        .pe-label {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          font-size: 0.85rem;
          font-weight: 500;
          color: var(--ink-2);
        }

        .pe-label--wide {
          grid-column: 1 / -1;
        }

        .pe-input {
          display: block;
          width: 100%;
          padding: 0.65rem 0.875rem;
          font-family: var(--font-sans);
          font-size: 1rem;
          color: var(--ink);
          background: var(--paper);
          border: 1px solid var(--rule);
          border-radius: 2px;
          transition: border-color 0.15s;
          box-sizing: border-box;
        }
        .pe-input:focus {
          outline: none;
          border-color: var(--ink);
        }
        .pe-textarea {
          resize: vertical;
          min-height: 6rem;
          line-height: 1.6;
        }

        /* Actions */
        .pe-actions {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 0.75rem;
        }

        .pe-btn {
          display: inline-flex;
          align-items: center;
          padding: 0.7rem 1.4rem;
          font-family: var(--font-mono);
          font-size: 0.8rem;
          font-weight: 500;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          border-radius: 2px;
          border: 1px solid transparent;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s;
        }
        .pe-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .pe-btn--primary {
          background: var(--ink);
          color: var(--paper);
          border-color: var(--ink);
        }
        .pe-btn--primary:hover:not(:disabled) {
          background: var(--clay-deep, #92400e);
          border-color: var(--clay-deep, #92400e);
        }

        .pe-btn--secondary {
          background: var(--paper);
          color: var(--ink);
          border-color: var(--rule);
        }
        .pe-btn--secondary:hover:not(:disabled) {
          border-color: var(--ink);
          background: var(--shade-1, #f9fafb);
        }

        .pe-message {
          font-family: var(--font-mono);
          font-size: 0.8rem;
          padding: 0.5rem 0.875rem;
          border-radius: 2px;
          border: 1px solid;
        }
        .pe-message--success { color: #166534; border-color: #bbf7d0; background: #f0fdf4; }
        .pe-message--error { color: #a8071a; border-color: #ffa39e; background: #fff1f0; }
        .pe-message--saving { color: var(--ink-3); border-color: var(--rule); background: var(--paper); }
      `}</style>
    </div>
  );
}
