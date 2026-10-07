/**
 * PROJECT EDITOR — create, edit, publish, archive and restore a project.
 *
 * Rendered by `PrivyRoot` beneath the one provider (`AccountIsland.astro`).
 *
 *   new project  POST /api/projects/ (title is enough) → a draft with an id
 *   save         PUT  /api/projects/<id>/ — every field; empty means clear
 *   cover        upload → confirm → `coverMediaId` in the next save
 *   publish      save, then POST /publish/ — the server returns every
 *                blocker at once, shown beside its field
 *   archive      POST /archive/  — owner only
 *   restore      POST /restore/  — owner only, back to draft
 *
 * What the editor offers follows the caller's role (owner / collaborator /
 * contributor) as the SERVER resolved it; the server enforces the same matrix
 * on every request regardless of what is offered here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount } from './account-context';
import { uploadImage, UploadProblem } from './upload-image';

type Role = 'owner' | 'collaborator' | 'contributor';

export interface ProjectEditorData {
  id?: string;
  slug?: string;
  title?: string;
  summary?: string | null;
  description?: string | null;
  claudeUsage?: string | null;
  cityId?: string | null;
  category?: string;
  url?: string | null;
  repoUrl?: string | null;
  videoUrl?: string | null;
  tags?: string[];
  coverMediaId?: string | null;
  coverUrl?: string | null;
  publicationStatus?: string;
  moderationState?: string;
  role?: Role;
  contentAuthority?: string;
}

interface CityOption {
  id: string;
  name: string;
}

const CATEGORIES: [string, string][] = [
  ['product', 'Product'],
  ['agent', 'Agent'],
  ['developer-tool', 'Developer tool'],
  ['research', 'Research'],
  ['creative', 'Creative'],
  ['campus', 'Campus'],
  ['experiment', 'Experiment'],
  ['startup', 'Startup'],
];

type Fields = {
  title: string;
  summary: string;
  description: string;
  claudeUsage: string;
  cityId: string;
  category: string;
  url: string;
  repoUrl: string;
  videoUrl: string;
  tags: string;
  coverMediaId: string | null;
};

function fieldsFrom(d: ProjectEditorData): Fields {
  return {
    title: d.title ?? '',
    summary: d.summary ?? '',
    description: d.description ?? '',
    claudeUsage: d.claudeUsage ?? '',
    cityId: d.cityId ?? '',
    category: d.category ?? 'product',
    url: d.url ?? '',
    repoUrl: d.repoUrl ?? '',
    videoUrl: d.videoUrl ?? '',
    tags: (d.tags ?? []).join(', '),
    coverMediaId: d.coverMediaId ?? null,
  };
}

function tagList(text: string): string[] {
  return [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 12);
}

type Notice = { tone: 'success' | 'error' | 'info'; text: string; signIn?: boolean; link?: string } | null;

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft — not public',
  published: 'Published',
  archived: 'Archived — not public',
};

export default function ProjectEditor({ initialData = {} }: { initialData?: ProjectEditorData }) {
  const account = useAccount();
  const role: Role = initialData.role ?? 'owner';
  const editable = role !== 'contributor' && (initialData.contentAuthority ?? 'member') === 'member';
  const isOwner = role === 'owner';

  const [id, setId] = useState(initialData.id);
  const [slug, setSlug] = useState(initialData.slug);
  const [status, setStatus] = useState(initialData.publicationStatus ?? 'draft');
  const [saved, setSaved] = useState<Fields>(() => fieldsFrom(initialData));
  const [form, setForm] = useState<Fields>(() => fieldsFrom(initialData));
  const [coverUrl, setCoverUrl] = useState(initialData.coverUrl ?? null);
  const [cities, setCities] = useState<CityOption[] | null>(null);
  const [busy, setBusy] = useState<'save' | 'publish' | 'archive' | 'restore' | 'upload' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);
  const held = ['restricted', 'removed', 'archived'].includes(initialData.moderationState ?? 'clean');

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

  const call = (path: string, init: RequestInit) =>
    account.fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });

  const failure = async (response: Response): Promise<Notice> => {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      field?: string;
      blockers?: { field: string; message: string }[];
    };
    if (body.blockers?.length) {
      setFieldErrors(Object.fromEntries(body.blockers.map((b) => [b.field, b.message])));
      return { tone: 'error', text: 'A few things are needed before this can be published — see the marked fields.' };
    }
    if (body.field) setFieldErrors({ [body.field]: body.error ?? 'Check this field.' });
    if (response.status === 401) {
      return { tone: 'error', text: 'Your session has expired. Sign in again — your edits are still here.', signIn: true };
    }
    return { tone: 'error', text: body.error ?? 'That did not work. Try again.' };
  };

  /** Create the draft if needed, then save every field. Returns the id. */
  const save = async (): Promise<string | null> => {
    let projectId = id;
    if (!projectId) {
      if (form.title.trim().length < 2) {
        setFieldErrors({ title: 'Give the project a name (at least two characters) to save it.' });
        return null;
      }
      const created = await call('/api/projects/', {
        method: 'POST',
        body: JSON.stringify({ title: form.title.trim(), category: form.category }),
      });
      if (!created.ok) {
        setNotice(await failure(created));
        return null;
      }
      const body = (await created.json()) as { id: string; slug: string };
      projectId = body.id;
      setId(body.id);
      setSlug(body.slug);
      window.history.replaceState({}, '', `/me/projects/${body.id}/edit/`);
    }

    const response = await call(`/api/projects/${projectId}/`, {
      method: 'PUT',
      body: JSON.stringify({
        title: form.title.trim(),
        summary: form.summary.trim() || null,
        description: form.description.trim() || null,
        claudeUsage: form.claudeUsage.trim() || null,
        cityId: form.cityId || null,
        category: form.category,
        // Empty means remove. The server turns "" into NULL.
        url: form.url.trim(),
        repoUrl: form.repoUrl.trim(),
        videoUrl: form.videoUrl.trim(),
        tags: tagList(form.tags),
        coverMediaId: form.coverMediaId,
      }),
    });
    if (!response.ok) {
      setNotice(await failure(response));
      return null;
    }
    setSaved(form);
    return projectId;
  };

  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    setFieldErrors({});
    try {
      await work();
    } catch {
      setNotice({ tone: 'error', text: 'We could not reach the server. Your edits are still here — try again.' });
    } finally {
      setBusy(null);
    }
  };

  const onSave = () =>
    run('save', async () => {
      if (await save()) {
        setNotice({
          tone: 'success',
          text: status === 'published' ? 'Saved. The public page shows these changes now.' : 'Draft saved. Nothing is public yet.',
        });
      }
    });

  const onPublish = () =>
    run('publish', async () => {
      const projectId = await save();
      if (!projectId) return;
      const response = await call(`/api/projects/${projectId}/publish/`, { method: 'POST', body: '{}' });
      if (!response.ok) {
        setNotice(await failure(response));
        return;
      }
      const body = (await response.json()) as { slug: string; url: string };
      setSlug(body.slug);
      setStatus('published');
      setNotice({ tone: 'success', text: 'Published. It is on the projects archive now.', link: body.url });
    });

  const onTransition = (action: 'archive' | 'restore') =>
    run(action, async () => {
      if (!id) return;
      if (action === 'archive' && !window.confirm('Archive this project? It will be taken off the website. You can restore it later.')) {
        return;
      }
      const response = await call(`/api/projects/${id}/${action}/`, { method: 'POST', body: '{}' });
      if (!response.ok) {
        setNotice(await failure(response));
        return;
      }
      const body = (await response.json()) as { status: string };
      setStatus(body.status);
      setNotice({
        tone: 'success',
        text: action === 'archive' ? 'Archived. It is no longer on the website.' : 'Restored as a draft. Publish it again when ready.',
      });
    });

  const onCover = (file: File | undefined) =>
    run('upload', async () => {
      if (!file || !id) return;
      try {
        const { mediaId, url } = await uploadImage(account, file, {
          purpose: 'cover',
          projectId: id,
          alt: `${form.title || 'Project'} — screenshot`,
        });
        set('coverMediaId', mediaId);
        setCoverUrl(url);
        setNotice({ tone: 'info', text: 'Share image uploaded. Save to keep it.' });
      } catch (error) {
        setNotice({
          tone: 'error',
          text: error instanceof UploadProblem ? error.message : 'The share image could not be uploaded.',
        });
      } finally {
        if (fileRef.current) fileRef.current.value = '';
      }
    });

  const sessionGone = account.state.status === 'signed-out';
  const disabled = busy !== null || !editable || sessionGone;
  const publicUrl = status === 'published' && slug ? `/projects/${slug}/` : null;

  const field = (key: keyof Fields | 'cityId', label: string, tag: string, input: React.ReactNode, hint?: string) => (
    <div className={`form-field${fieldErrors[key] ? ' form-field--error' : ''}${['description', 'claudeUsage', 'summary'].includes(key) ? ' form-field--wide' : ''}`}>
      <label className="field-label" htmlFor={`pj-${key}`}>
        {label} <span className="field-tag">{tag}</span>
      </label>
      {input}
      {hint && (
        <p className="field-hint" id={`pj-${key}-hint`}>
          {hint}
        </p>
      )}
      {fieldErrors[key] && (
        <p className="field-error" id={`pj-${key}-error`}>
          {fieldErrors[key]}
        </p>
      )}
    </div>
  );
  const aria = (key: string, hint = false) => ({
    'aria-invalid': Boolean(fieldErrors[key]),
    'aria-describedby':
      [fieldErrors[key] ? `pj-${key}-error` : '', hint ? `pj-${key}-hint` : ''].filter(Boolean).join(' ') || undefined,
  });

  return (
    <form
      className="project-editor"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
    >
      <div className="panel">
        <div className="panel-head">
          <h2>Status</h2>
          <span className={`status-badge status-badge--${held ? 'held' : status}`}>
            {held ? 'Held by moderators' : (STATUS_LABEL[status] ?? status)}
          </span>
        </div>
        <p className="panel-hint">
          {publicUrl ? (
            <>
              Live at <a href={publicUrl}>{publicUrl}</a>. Saved edits appear there straight away.
            </>
          ) : status === 'archived' ? (
            'Archived projects are not on the website. Restore to bring it back as a draft.'
          ) : (
            'Drafts are visible only to you and your collaborators.'
          )}
        </p>
        {!editable && (
          <div className="notice notice--info" style={{ marginTop: 'var(--s-4)' }}>
            {role === 'contributor'
              ? 'You are credited on this project. Only its owner and collaborators can edit it.'
              : 'This project is managed by the organisers until it is claimed.'}
          </div>
        )}
        {held && (
          <div className="notice notice--error" style={{ marginTop: 'var(--s-4)' }}>
            Moderators have taken this project off the website. You can still edit it; publishing is paused until they review it.
          </div>
        )}
        {sessionGone && (
          <div className="notice notice--error" role="alert" style={{ marginTop: 'var(--s-4)' }}>
            You are signed out. Sign in again before saving — your edits stay on this page.{' '}
            <button type="button" className="button button--quiet" onClick={account.signIn}>
              Sign in
            </button>
          </div>
        )}
      </div>

      <fieldset className="panel" disabled={!editable}>
        <div className="panel-head">
          <h2>Basics</h2>
        </div>
        <div className="form-grid form-grid--two">
          {field(
            'title',
            'Project name',
            'required',
            <input id="pj-title" className="input" value={form.title} maxLength={100} onChange={(e) => set('title', e.target.value)} {...aria('title')} />,
          )}
          {field(
            'category',
            'Category',
            'required',
            <select id="pj-category" className="input" value={form.category} onChange={(e) => set('category', e.target.value)} {...aria('category')}>
              {CATEGORIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>,
          )}
          {field(
            'summary',
            'Tagline',
            'needed to publish',
            <input id="pj-summary" className="input" value={form.summary} maxLength={300} placeholder="One sentence: what it does and who it is for." onChange={(e) => set('summary', e.target.value)} {...aria('summary', true)} />,
            'Shown on project cards and in search. At least five characters.',
          )}
          {field(
            'cityId',
            'City',
            'needed to publish',
            <select id="pj-cityId" className="input" value={form.cityId} onChange={(e) => set('cityId', e.target.value)} {...aria('cityId')}>
              <option value="">{cities === null ? 'Loading cities…' : 'Choose a city'}</option>
              {(cities ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>,
          )}
          {field(
            'tags',
            'Tools and tags',
            'optional',
            <input id="pj-tags" className="input" value={form.tags} placeholder="Claude Code, MCP, Next.js" onChange={(e) => set('tags', e.target.value)} {...aria('tags', true)} />,
            'Comma-separated, up to 12.',
          )}
        </div>
      </fieldset>

      <fieldset className="panel" disabled={!editable}>
        <div className="panel-head">
          <h2>The story</h2>
        </div>
        <div className="form-grid">
          {field(
            'description',
            'What it does',
            'needed to publish',
            <textarea id="pj-description" className="input" rows={6} value={form.description} maxLength={10000} placeholder="The problem, who it is for, and how it works." onChange={(e) => set('description', e.target.value)} {...aria('description')} />,
          )}
          {field(
            'claudeUsage',
            'How Claude was used',
            'needed to publish',
            <textarea id="pj-claudeUsage" className="input" rows={4} value={form.claudeUsage} maxLength={1000} placeholder="What Claude actually did, and what you did." onChange={(e) => set('claudeUsage', e.target.value)} {...aria('claudeUsage', true)} />,
            `${form.claudeUsage.length}/1000`,
          )}
        </div>
      </fieldset>

      <fieldset className="panel" disabled={!editable}>
        <div className="panel-head">
          <h2>Links</h2>
          <span className="panel-hint">Optional. Full http(s) links. Leave empty to remove.</span>
        </div>
        <div className="form-grid form-grid--two">
          {field('url', 'Live project', 'optional', <input id="pj-url" className="input" type="url" inputMode="url" value={form.url} placeholder="https://" onChange={(e) => set('url', e.target.value)} {...aria('url')} />)}
          {field('repoUrl', 'Source code', 'optional', <input id="pj-repoUrl" className="input" type="url" inputMode="url" value={form.repoUrl} placeholder="https://github.com/…" onChange={(e) => set('repoUrl', e.target.value)} {...aria('repoUrl')} />)}
          {field('videoUrl', 'Demo video', 'optional', <input id="pj-videoUrl" className="input" type="url" inputMode="url" value={form.videoUrl} placeholder="https://" onChange={(e) => set('videoUrl', e.target.value)} {...aria('videoUrl')} />)}
        </div>
      </fieldset>

      <fieldset className="panel" disabled={!editable}>
        <div className="panel-head">
          <h2>Share image</h2>
          <span className="panel-hint">Optional · shown when someone shares your project page · JPEG, PNG, WebP · up to 5 MB</span>
        </div>
        <div className="image-picker">
          {coverUrl && form.coverMediaId ? (
            <img src={coverUrl} alt="Current share image" width={448} height={280} />
          ) : (
            <p className="panel-hint">No share image. Links to this project show the site card.</p>
          )}
          {id ? (
            <>
              <label className="field-label" htmlFor="pj-cover">
                {form.coverMediaId ? 'Replace share image' : 'Upload a share image'}
              </label>
              <input
                id="pj-cover"
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                disabled={disabled}
                onChange={(e) => void onCover(e.target.files?.[0])}
              />
            </>
          ) : (
            <p className="panel-hint">Save the draft first, then add a share image.</p>
          )}
          {form.coverMediaId && (
            <button type="button" className="button button--quiet" onClick={() => set('coverMediaId', null)}>
              Remove share image
            </button>
          )}
          {busy === 'upload' && <p className="panel-hint" aria-live="polite">Uploading…</p>}
          {fieldErrors.coverMediaId && <p className="field-error">{fieldErrors.coverMediaId}</p>}
        </div>
      </fieldset>

      {editable && (
        <div className="form-actions form-actions--sticky">
          {isOwner && status !== 'published' && status !== 'archived' && (
            <button type="button" className="button button--primary" disabled={disabled || held} onClick={() => void onPublish()}>
              {busy === 'publish' ? 'Publishing…' : 'Publish'}
            </button>
          )}
          <button type="submit" className={`button${!isOwner || status === 'published' ? ' button--primary' : ''}`} disabled={disabled || (Boolean(id) && !dirty)}>
            {busy === 'save' ? 'Saving…' : !id ? 'Save draft' : dirty ? 'Save changes' : 'Saved'}
          </button>
          {publicUrl && (
            <a className="button button--quiet" href={publicUrl}>
              View public page
            </a>
          )}
          {isOwner && id && status !== 'archived' && (
            <button type="button" className="button button--danger" disabled={disabled} onClick={() => void onTransition('archive')}>
              {busy === 'archive' ? 'Archiving…' : 'Archive'}
            </button>
          )}
          {isOwner && id && status === 'archived' && (
            <button type="button" className="button" disabled={disabled} onClick={() => void onTransition('restore')}>
              {busy === 'restore' ? 'Restoring…' : 'Restore as draft'}
            </button>
          )}
        </div>
      )}

      <div aria-live="polite">
        {notice && (
          <div className={`notice notice--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
            {notice.text}{' '}
            {notice.link && <a href={notice.link}>View it</a>}
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
