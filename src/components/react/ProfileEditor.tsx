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

  const save = async () => {
    setStatus('saving');
    try {
      /**
       * Omit — not send empty — the two fields the schema cannot accept as
       * an empty string.
       *
       * `primaryRole` is `z.enum(SELECTABLE_ROLES)`: every profile starts
       * with `primaryRole: null`, this form defaults that to `''`, and `''`
       * is not a member of the enum — so it failed validation on every save
       * until a member happened to type one of the exact eleven strings by
       * hand, back when this was a free-text input. `website` is an HTTPS
       * URL schema that calls `new URL(value)`, which throws on `''` too.
       *
       * `.optional()` on both means the KEY may be absent — "don't touch
       * this field" — which is what an empty selection should mean here.
       * `citySlug` is deliberately NOT in this list: the server explicitly
       * maps `citySlug: ''` to "clear the city" (see
       * `src/server/members/profile.ts`'s `updateProfile()`), so sending it
       * is the correct way to let a member remove their city.
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
      setStatus('success');
      setMessage('Changes saved.');
      window.location.assign('/me/profile/');
    } catch {
      // Only reachable now for an actual network failure — DNS, connection
      // refused, offline — since `accountFetch` no longer lets a missing
      // Privy context surface here as a false "network error".
      setStatus('error');
      setMessage('Network error while saving. Check your connection and try again.');
    }
  };

  return (
    <div className="account-editor">
      <div className="editor-grid">
        <label>
          <span>Name</span>
          <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </label>
        <label>
          <span>Username</span>
          <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </label>
        <label>
          <span>City</span>
          <select value={form.citySlug} onChange={(e) => setForm({ ...form, citySlug: e.target.value })}>
            <option value="">Choose…</option>
            {cities.map((city) => <option key={city.slug} value={city.slug}>{city.name}</option>)}
          </select>
        </label>
        <label>
          <span>What you do</span>
          {/*
            A `<select>` over the same enum the server validates against —
            see `src/lib/roles.ts`. This used to be a free-text `<input>`
            while the server enforced a closed list, which is the frontend
            and backend disagreeing on STRUCTURE (§6/§7 of the diagnosis):
            not a typo in a field name, but two different shapes for the
            same field.
          */}
          <select value={form.primaryRole} onChange={(e) => setForm({ ...form, primaryRole: e.target.value })}>
            <option value="">Choose…</option>
            {SELECTABLE_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
        </label>
        <label>
          <span>Headline</span>
          <input value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} />
        </label>
        <label>
          <span>Bio</span>
          <textarea value={form.bio} rows={4} onChange={(e) => setForm({ ...form, bio: e.target.value })} />
        </label>
        <label>
          <span>Claude tools</span>
          <input value={form.claudeSince} onChange={(e) => setForm({ ...form, claudeSince: e.target.value })} />
        </label>
        <label>
          <span>Website</span>
          <input type="url" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
        </label>
        <label>
          <span>Profile visibility</span>
          <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
            <option value="public">Public</option>
            <option value="unlisted">Unlisted</option>
          </select>
        </label>
      </div>

      <div className="editor-actions">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving...' : 'Save changes'}
        </button>
        {message && <p className={`editor-message ${status}`}>{message}</p>}
      </div>
    </div>
  );
}
