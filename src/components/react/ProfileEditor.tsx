/**
 * PROFILE EDITOR — the Builder Passport form.
 *
 * Rendered by `PrivyRoot` beneath the one `PrivyProvider` (see
 * `AccountIsland.astro`), so `useAccount()` is real here; it used to be a
 * separate island calling `usePrivy()` with no provider.
 *
 *   Save draft        PATCH /api/member/profile/   — the passport only
 *   Publish / Update  PATCH, then POST               — projects it to the
 *                                                     public builder page
 *
 * Every field is sent on save, and an emptied field is sent as empty — the
 * server stores NULL. The old editor omitted an empty website or role
 * because the schema rejected `""`, so those could never be cleared.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SELECTABLE_ROLES } from '@/lib/roles';
import { useAccount, USERNAME_SAVED_EVENT } from './account-context';
import { uploadImage, UploadProblem } from './upload-image';

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
  /** The public builder slug, once published. Fixed at first publication. */
  builderSlug?: string | null;
  avatarMediaId?: string | null;
  avatarUrl?: string | null;
}

interface Props {
  profile: ProfileEditorProfile;
  /** `avatars/<memberId>/` — where this member may upload a portrait. */
  uploadPrefix: string;
}

interface CityOption {
  slug: string;
  name: string;
}

type Fields = {
  username: string;
  displayName: string;
  citySlug: string;
  primaryRole: string;
  headline: string;
  bio: string;
  claudeSince: string;
  website: string;
  visibility: string;
  avatarMediaId: string | null;
};

const PLACEHOLDER_USERNAME = /^m-[0-9a-f]{12}$/;

/** A server field name to its control's id, where the two differ. */
const CONTROL_ID: Record<string, string> = {
  citySlug: 'pe-city',
  primaryRole: 'pe-role',
  claudeSince: 'pe-tools',
};

function initialFields(p: ProfileEditorProfile): Fields {
  return {
    username: PLACEHOLDER_USERNAME.test(p.username) ? '' : p.username,
    displayName: p.displayName ?? '',
    citySlug: p.citySlug ?? '',
    primaryRole: p.primaryRole ?? '',
    headline: p.headline ?? '',
    bio: p.bio ?? '',
    claudeSince: p.claudeSince ?? '',
    website: p.website ?? '',
    visibility: p.visibility === 'unlisted' ? 'unlisted' : 'public',
    avatarMediaId: p.avatarMediaId ?? null,
  };
}

/** The client's copy of `missingForPublish()`, for the readiness list only. */
function publishBlockers(f: Fields): string[] {
  return [
    !f.username.trim() && 'Choose a username',
    !f.displayName.trim() && 'Add your name',
    !f.citySlug && 'Choose a city',
    !f.primaryRole && 'Choose what you do',
  ].filter(Boolean) as string[];
}

type Notice = { tone: 'success' | 'error' | 'info'; text: string; signIn?: boolean } | null;

export default function ProfileEditor({ profile, uploadPrefix }: Props) {
  const account = useAccount();
  const [saved, setSaved] = useState<Fields>(() => initialFields(profile));
  const [form, setForm] = useState<Fields>(() => initialFields(profile));
  const [cities, setCities] = useState<CityOption[] | null>(null);
  const [busy, setBusy] = useState<'save' | 'publish' | 'upload' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [published, setPublished] = useState(Boolean(profile.publishedAt));
  const [builderSlug, setBuilderSlug] = useState(profile.builderSlug ?? null);
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusId = useRef<string | null>(null);

  // Move to the field the server rejected once its error is rendered, so it is read with it.
  useEffect(() => {
    const control = focusId.current ? document.getElementById(focusId.current) : null;
    focusId.current = null;
    control?.scrollIntoView({ block: 'center' });
    control?.focus({ preventScroll: true });
  }, [fieldErrors]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);
  const blockers = publishBlockers(form);

  // Live city options — the same list the server validates against.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/cities/')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((rows: CityOption[]) => !cancelled && setCities(rows))
      .catch(() => !cancelled && setCities([]));
    return () => {
      cancelled = true;
    };
  }, []);

  // Unsaved changes survive an accidental navigation only if we ask.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const set = useCallback(<K extends keyof Fields>(key: K, value: Fields[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => (prev[key] ? { ...prev, [key]: '' } : prev));
  }, []);

  const failure = async (response: Response): Promise<Notice> => {
    const body = (await response.json().catch(() => ({}))) as { error?: string; field?: string };
    if (body.field) setFieldErrors({ [body.field]: body.error ?? 'Check this field.' });
    if (response.status === 401) {
      return {
        tone: 'error',
        text: 'Your session has expired. Sign in again — your edits are still here.',
        signIn: true,
      };
    }
    // The error shows under its field: focus that instead of repeating it below the buttons.
    const control = body.field
      ? document.getElementById(CONTROL_ID[body.field] ?? `pe-${body.field}`)
      : null;
    if (control) {
      focusId.current = control.id;
      return null;
    }
    return { tone: 'error', text: body.error ?? 'Your changes could not be saved. Try again.' };
  };

  const savePassport = async (): Promise<boolean> => {
    const body: Record<string, unknown> = {
      displayName: form.displayName,
      citySlug: form.citySlug || null,
      primaryRole: form.primaryRole || null,
      headline: form.headline,
      bio: form.bio,
      claudeSince: form.claudeSince,
      website: form.website.trim() || null,
      visibility: form.visibility,
      avatarMediaId: form.avatarMediaId,
    };
    if (form.username.trim()) body.username = form.username.trim().toLowerCase();

    const response = await account.fetch('/api/member/profile/', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      setNotice(await failure(response));
      return false;
    }
    setSaved(form);
    // Ends the header's "Finish your profile" nudge, here and on the next page (PrivyRoot).
    // A placeholder-shaped handle still counts as no username on the server (isPlaceholderUsername).
    if (body.username && !PLACEHOLDER_USERNAME.test(body.username as string)) {
      window.dispatchEvent(new Event(USERNAME_SAVED_EVENT));
    }
    return true;
  };

  const onSave = async () => {
    setBusy('save');
    setNotice(null);
    setFieldErrors({});
    try {
      if (await savePassport()) {
        setNotice({
          tone: 'success',
          text: published
            ? 'Saved. Your public profile still shows the last published version until you update it.'
            : 'Saved as a draft. Nothing is public until you publish.',
        });
      }
    } catch {
      setNotice({
        tone: 'error',
        text: 'We could not reach the server. Your edits are still here — try again.',
      });
    } finally {
      setBusy(null);
    }
  };

  const onPublish = async () => {
    setBusy('publish');
    setNotice(null);
    setFieldErrors({});
    try {
      if (!(await savePassport())) return;
      const response = await account.fetch('/api/member/profile/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        setNotice(await failure(response));
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { slug?: string };
      const slug = body.slug ?? builderSlug;
      setPublished(true);
      if (slug) setBuilderSlug(slug);
      setNotice({
        tone: 'success',
        text:
          form.visibility === 'unlisted'
            ? 'Published. Your profile is live for anyone with the link, and is not listed or indexed.'
            : 'Published. Your profile is live and listed in the builders directory.',
      });
    } catch {
      setNotice({
        tone: 'error',
        text: 'We could not reach the server. Your edits are still here — try again.',
      });
    } finally {
      setBusy(null);
    }
  };

  const onPortrait = async (file: File | undefined) => {
    if (!file) return;
    setBusy('upload');
    setNotice(null);
    try {
      const { mediaId, url } = await uploadImage(account, file, {
        purpose: 'avatar',
        prefix: uploadPrefix,
        alt: `Portrait of ${form.displayName || 'this builder'}`,
      });
      set('avatarMediaId', mediaId);
      setAvatarUrl(url);
      setNotice({
        tone: 'info',
        text: 'Portrait uploaded. Save to keep it; it goes public when you publish.',
      });
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof UploadProblem ? error.message : 'The portrait could not be uploaded.',
      });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const sessionGone = account.state.status === 'signed-out';
  const publicPath = `/builders/${builderSlug ?? (form.username.trim().toLowerCase() || 'your-username')}/`;
  const err = (key: string) =>
    fieldErrors[key] ? (
      <p className="field-error" id={`pe-${key}-error`}>
        {fieldErrors[key]}
      </p>
    ) : null;
  const describedBy = (key: string, hint?: boolean) =>
    [fieldErrors[key] ? `pe-${key}-error` : '', hint ? `pe-${key}-hint` : '']
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <form
      className="profile-editor"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <div className="panel">
        <div className="panel-head">
          <h2>Status</h2>
          <span className={`status-badge status-badge--${published ? 'published' : 'draft'}`}>
            {published
              ? form.visibility === 'unlisted'
                ? 'Live · unlisted'
                : 'Live · listed'
              : 'Not public yet'}
          </span>
        </div>
        <p className="panel-hint">
          {published ? (
            <>
              Your page is <a href={publicPath}>{publicPath}</a>.{' '}
              {saved.visibility === 'unlisted'
                ? 'Unlisted means anyone with the link can open it, but it is not in the directory, search or sitemap. It is not private.'
                : 'It is listed in the builders directory and can appear in search.'}
            </>
          ) : (
            <>Publishing creates your page at {publicPath}. Until then nothing here is public.</>
          )}
        </p>
        {sessionGone && (
          <div className="notice notice--error" role="alert" style={{ marginTop: 'var(--s-4)' }}>
            You are signed out. Sign in again before saving — your edits stay on this page.{' '}
            <button type="button" className="button button--quiet" onClick={account.signIn}>
              Sign in
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>About you</h2>
        </div>
        <div className="form-grid form-grid--two">
          <div className={`form-field${fieldErrors.displayName ? ' form-field--error' : ''}`}>
            <label className="field-label" htmlFor="pe-displayName">
              Name <span className="field-tag">needed to publish</span>
            </label>
            <input
              id="pe-displayName"
              className="input"
              value={form.displayName}
              maxLength={80}
              autoComplete="name"
              aria-invalid={Boolean(fieldErrors.displayName)}
              aria-describedby={describedBy('displayName')}
              onChange={(e) => set('displayName', e.target.value)}
            />
            {err('displayName')}
          </div>

          <div className={`form-field${fieldErrors.username ? ' form-field--error' : ''}`}>
            <label className="field-label" htmlFor="pe-username">
              Username <span className="field-tag">needed to publish</span>
            </label>
            <input
              id="pe-username"
              className="input"
              value={form.username}
              maxLength={30}
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={Boolean(fieldErrors.username)}
              aria-describedby={describedBy('username', true)}
              onChange={(e) => set('username', e.target.value)}
            />
            <p className="field-hint" id="pe-username-hint">
              3–30 lower-case letters, numbers, - or _.
              {builderSlug
                ? ` Your public address stays ${`/builders/${builderSlug}/`} even if you change it.`
                : ''}
            </p>
            {err('username')}
          </div>

          <div className={`form-field${fieldErrors.citySlug ? ' form-field--error' : ''}`}>
            <label className="field-label" htmlFor="pe-city">
              City <span className="field-tag">needed to publish</span>
            </label>
            <select
              id="pe-city"
              className="input"
              value={form.citySlug}
              aria-invalid={Boolean(fieldErrors.citySlug)}
              aria-describedby={describedBy('citySlug')}
              onChange={(e) => set('citySlug', e.target.value)}
            >
              <option value="">{cities === null ? 'Loading cities…' : 'Choose a city'}</option>
              {(cities ?? []).map((city) => (
                <option key={city.slug} value={city.slug}>
                  {city.name}
                </option>
              ))}
              {/* Keep the saved value selectable even before the list loads. */}
              {form.citySlug &&
                cities !== null &&
                !cities.some((c) => c.slug === form.citySlug) && (
                  <option value={form.citySlug}>{form.citySlug}</option>
                )}
            </select>
            {cities !== null && cities.length === 0 && (
              <p className="field-hint">The city list could not be loaded. Reload to try again.</p>
            )}
            {err('citySlug')}
          </div>

          <div className={`form-field${fieldErrors.primaryRole ? ' form-field--error' : ''}`}>
            <label className="field-label" htmlFor="pe-role">
              What you do <span className="field-tag">needed to publish</span>
            </label>
            <select
              id="pe-role"
              className="input"
              value={form.primaryRole}
              aria-invalid={Boolean(fieldErrors.primaryRole)}
              aria-describedby={describedBy('primaryRole')}
              onChange={(e) => set('primaryRole', e.target.value)}
            >
              <option value="">Choose one</option>
              {SELECTABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            {err('primaryRole')}
          </div>

          <div
            className={`form-field form-field--wide${fieldErrors.headline ? ' form-field--error' : ''}`}
          >
            <label className="field-label" htmlFor="pe-headline">
              Headline <span className="field-tag">optional</span>
            </label>
            <input
              id="pe-headline"
              className="input"
              value={form.headline}
              maxLength={140}
              placeholder="One sentence about what you build with Claude."
              aria-invalid={Boolean(fieldErrors.headline)}
              aria-describedby={describedBy('headline')}
              onChange={(e) => set('headline', e.target.value)}
            />
            {err('headline')}
          </div>

          <div
            className={`form-field form-field--wide${fieldErrors.bio ? ' form-field--error' : ''}`}
          >
            <label className="field-label" htmlFor="pe-bio">
              Bio <span className="field-tag">optional</span>
            </label>
            <textarea
              id="pe-bio"
              className="input"
              value={form.bio}
              rows={5}
              maxLength={2000}
              aria-invalid={Boolean(fieldErrors.bio)}
              aria-describedby={describedBy('bio', true)}
              onChange={(e) => set('bio', e.target.value)}
            />
            <p className="field-hint" id="pe-bio-hint">
              {form.bio.length}/2000
            </p>
            {err('bio')}
          </div>

          <div className={`form-field${fieldErrors.claudeSince ? ' form-field--error' : ''}`}>
            <label className="field-label" htmlFor="pe-tools">
              Claude tools you use <span className="field-tag">optional</span>
            </label>
            <input
              id="pe-tools"
              className="input"
              value={form.claudeSince}
              maxLength={40}
              placeholder="Claude Code, the API…"
              aria-invalid={Boolean(fieldErrors.claudeSince)}
              onChange={(e) => set('claudeSince', e.target.value)}
            />
            {err('claudeSince')}
          </div>

          <div className={`form-field${fieldErrors.website ? ' form-field--error' : ''}`}>
            <label className="field-label" htmlFor="pe-website">
              Website <span className="field-tag">optional</span>
            </label>
            <input
              id="pe-website"
              className="input"
              type="url"
              inputMode="url"
              value={form.website}
              placeholder="https://"
              aria-invalid={Boolean(fieldErrors.website)}
              aria-describedby={describedBy('website', true)}
              onChange={(e) => set('website', e.target.value)}
            />
            <p className="field-hint" id="pe-website-hint">
              Must start with https://. Leave empty to remove it.
            </p>
            {err('website')}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Portrait</h2>
          <span className="panel-hint">Optional · JPEG, PNG, WebP · up to 5 MB</span>
        </div>
        <div className="image-picker image-picker--round">
          {avatarUrl && form.avatarMediaId ? (
            <img src={avatarUrl} alt="Your current portrait" width={112} height={112} />
          ) : (
            <p className="panel-hint">No portrait. Your page shows your name without one.</p>
          )}
          <label className="field-label" htmlFor="pe-portrait">
            {form.avatarMediaId ? 'Replace portrait' : 'Upload a portrait'}
          </label>
          <input
            id="pe-portrait"
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
            disabled={busy !== null}
            onChange={(e) => void onPortrait(e.target.files?.[0])}
          />
          {form.avatarMediaId && (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => set('avatarMediaId', null)}
            >
              Remove portrait
            </button>
          )}
          {busy === 'upload' && (
            <p className="panel-hint" aria-live="polite">
              Uploading…
            </p>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Visibility</h2>
        </div>
        <fieldset className="form-grid">
          <legend className="visually-hidden">Who can find your profile</legend>
          <label className="field-label">
            <input
              type="radio"
              name="visibility"
              value="public"
              checked={form.visibility === 'public'}
              onChange={() => set('visibility', 'public')}
            />{' '}
            Listed — in the builders directory, search and sitemap
          </label>
          <label className="field-label">
            <input
              type="radio"
              name="visibility"
              value="unlisted"
              checked={form.visibility === 'unlisted'}
              onChange={() => set('visibility', 'unlisted')}
            />{' '}
            Unlisted — anyone with the link can open it; not listed or indexed
          </label>
        </fieldset>
      </div>

      {blockers.length > 0 && (
        <div className="notice notice--info" role="status" style={{ marginTop: 'var(--s-5)' }}>
          Before you can publish:
          <ul>
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="form-actions form-actions--sticky">
        <button
          type="button"
          className="button button--primary"
          disabled={busy !== null || blockers.length > 0 || sessionGone}
          onClick={() => void onPublish()}
        >
          {busy === 'publish'
            ? 'Publishing…'
            : published
              ? 'Update public profile'
              : 'Publish profile'}
        </button>
        <button type="submit" className="button" disabled={busy !== null || !dirty || sessionGone}>
          {busy === 'save' ? 'Saving…' : dirty ? 'Save draft' : 'Saved'}
        </button>
        {published && builderSlug && (
          <a className="button button--quiet" href={`/builders/${builderSlug}/`}>
            View public profile
          </a>
        )}
      </div>

      <div aria-live="polite">
        {notice && (
          <div
            className={`notice notice--${notice.tone}`}
            role={notice.tone === 'error' ? 'alert' : 'status'}
          >
            {notice.text}{' '}
            {notice.signIn && (
              <button type="button" className="button button--quiet" onClick={account.signIn}>
                Sign in
              </button>
            )}
          </div>
        )}
      </div>
    </form>
  );
}
