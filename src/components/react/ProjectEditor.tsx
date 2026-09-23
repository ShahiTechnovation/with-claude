/**
 * PROJECT EDITOR — the member's project publishing composer.
 *
 * Flow (deterministic):
 *   1. Member opens /me/projects/new (or /me/projects/{id}/edit for existing)
 *   2. Fill in fields
 *   3. "Save Draft" → POST /api/projects/ with ONLY the create payload fields
 *      → receives { id, slug } → URL changes to /me/projects/{id}/edit/
 *      → further saves use PUT /api/projects/{id}/
 *   4. Optionally upload cover (requires draft to exist first for projectId)
 *   5. "Publish" → PUT (save) then POST /api/projects/{id}/publish/
 *      → server returns publish blockers if any fields are missing
 *   6. Success → public URL shown, link to /projects/{slug}/
 *
 * ── BUGS THIS FILE FIXES ─────────────────────────────────────────────────
 *
 * A. CreateProjectSchema is .strict() and only accepts title, summary,
 *    description, claudeUsage, cityId, category. The old editor sent ALL form
 *    fields on create, including url/repoUrl/videoUrl/imagePath which the
 *    schema rejects. Fix: separate create payload from edit payload.
 *
 * B. Empty URL strings ("") fail httpUrl validation. Fix: server now coerces
 *    empty strings to null, and we omit blank URL fields from the payload.
 *
 * G. publishBlockers() returns all blockers at once. Fix: render all
 *    returned blockers next to the relevant fields.
 *
 * I. No city selector. Fix: city <select> from the authoritative cities list.
 *
 * J/K. UX quality: composer layout, clear action hierarchy, status badges,
 *    no "Advanced Settings" anti-pattern, upload progress, public link.
 */
import React, { useEffect, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { usePrivy } from '@privy-io/react-auth';
import { accountFetch, describeAccountError } from '@/lib/account-fetch';

interface CityOption {
  id: string;
  name: string;
  slug: string;
}

interface InitialData {
  id?: string;
  title?: string;
  summary?: string;
  description?: string;
  claudeUsage?: string;
  cityId?: string;
  category?: string;
  url?: string;
  repoUrl?: string;
  videoUrl?: string;
  imagePath?: string;
  publicationStatus?: string;
}

interface PublishBlocker {
  field: string;
  message: string;
}

export default function ProjectEditor({ initialData = {} }: { initialData?: InitialData }) {
  const { getAccessToken } = usePrivy();
  const [form, setForm] = useState({
    title: initialData.title ?? '',
    summary: initialData.summary ?? '',
    description: initialData.description ?? '',
    claudeUsage: initialData.claudeUsage ?? '',
    cityId: initialData.cityId ?? '',
    category: initialData.category ?? 'product',
    url: initialData.url ?? '',
    repoUrl: initialData.repoUrl ?? '',
    videoUrl: initialData.videoUrl ?? '',
    imagePath: initialData.imagePath ?? '',
  });

  const [id, setId] = useState<string | undefined>(initialData.id);
  const [status, setStatus] = useState(initialData.publicationStatus ?? 'draft');
  const [slug, setSlug] = useState<string | undefined>();
  const [cityOptions, setCityOptions] = useState<CityOption[]>([]);
  const [loading, setLoading] = useState<'save' | 'publish' | 'archive' | 'restore' | null>(null);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [successUrl, setSuccessUrl] = useState<string | undefined>(
    initialData.publicationStatus === 'published' && initialData.id
      ? `/projects/${initialData.id}/`
      : undefined,
  );
  const [file, setFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(form.imagePath || null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch DB cities on mount — we need real DB UUIDs, not the static fixture IDs.
  useEffect(() => {
    fetch('/api/cities')
      .then((r) => r.json())
      .then((data: CityOption[]) => setCityOptions(data))
      .catch(() => {
        // Non-fatal: city selector shows empty but editor still works.
        setCityOptions([]);
      });
  }, []);

  /** A mutation to this project's own API, via accountFetch. */
  const mutate = (path: string, init: RequestInit) =>
    accountFetch(
      path,
      { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } },
      getAccessToken,
    );

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
    // Clear the field-level error as the member types.
    if (fieldErrors[name]) setFieldErrors((prev) => ({ ...prev, [name]: '' }));
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    if (f) {
      const url = URL.createObjectURL(f);
      setCoverPreview(url);
    } else {
      setCoverPreview(form.imagePath || null);
    }
  };

  /**
   * The create payload: ONLY the fields CreateProjectSchema accepts.
   *
   * CreateProjectSchema is .strict(), so sending any unknown key returns 422.
   * url/repoUrl/videoUrl/imagePath are only accepted by EditProjectSchema (PUT)
   * after the draft exists. This is the single place that decides what goes in
   * the create POST.
   */
  const buildCreatePayload = () => {
    const payload: Record<string, unknown> = { title: form.title };
    if (form.summary.trim()) payload.summary = form.summary.trim();
    if (form.description.trim()) payload.description = form.description.trim();
    if (form.claudeUsage.trim()) payload.claudeUsage = form.claudeUsage.trim();
    if (form.cityId) payload.cityId = form.cityId;
    if (form.category) payload.category = form.category;
    return payload;
  };

  /**
   * The update payload: all fields, with empty URL strings omitted
   * (server coerces "" to null, but it's cleaner not to send them).
   */
  const buildUpdatePayload = (overrides: Partial<typeof form> = {}) => {
    const merged = { ...form, ...overrides };
    const payload: Record<string, unknown> = {
      title: merged.title,
      summary: merged.summary || null,
      description: merged.description || null,
      claudeUsage: merged.claudeUsage || null,
      cityId: merged.cityId || null,
      category: merged.category,
    };
    if (merged.url.trim()) payload.url = merged.url.trim();
    if (merged.repoUrl.trim()) payload.repoUrl = merged.repoUrl.trim();
    if (merged.videoUrl.trim()) payload.videoUrl = merged.videoUrl.trim();
    if (merged.imagePath) payload.imagePath = merged.imagePath;
    return payload;
  };

  const handleSave = async (publish: boolean) => {
    setLoading(publish ? 'publish' : 'save');
    setError('');
    setFieldErrors({});

    try {
      let currentId = id;
      let currentSlug: string | undefined = slug;

      // ── Step 1: Create draft if no id yet ─────────────────────────────────
      if (!currentId) {
        if (!form.title.trim()) {
          setError('Give the project a name to save a draft.');
          return;
        }
        const res = await mutate('/api/projects/', {
          method: 'POST',
          body: JSON.stringify(buildCreatePayload()),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || (await describeAccountError(res)));
        currentId = data.id;
        currentSlug = data.slug;
        setId(currentId);
        setSlug(currentSlug);
        window.history.replaceState({}, '', `/me/projects/${currentId}/edit/`);
      }

      // ── Step 2: Upload cover if a file was selected ────────────────────────
      let finalImagePath = form.imagePath;
      if (file) {
        setUploadProgress('Uploading cover…');
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          if (typeof args[0] === 'string' && args[0].includes('/api/media/upload')) {
            args[1] = { ...args[1], credentials: 'include' };
          }
          return originalFetch(...args);
        };

        try {
          const newBlob = await upload(file.name, file, {
            access: 'public',
            handleUploadUrl: '/api/media/upload',
            clientPayload: JSON.stringify({
              projectId: currentId,
              alt: form.title || 'Project cover image',
            }),
          });
          finalImagePath = newBlob.url;
          setForm((prev) => ({ ...prev, imagePath: newBlob.url }));
          setCoverPreview(newBlob.url);
          setFile(null);
        } catch (uploadErr: any) {
          // Upload failure is non-fatal: show the error but continue saving
          // the rest of the project data. The member can publish without a cover.
          setError(uploadErr.message ?? 'Cover upload failed. The project was saved without it.');
          finalImagePath = form.imagePath;
        } finally {
          window.fetch = originalFetch;
          setUploadProgress(null);
        }
      }

      // ── Step 3: Save all fields via PUT ───────────────────────────────────
      const putRes = await mutate(`/api/projects/${currentId}/`, {
        method: 'PUT',
        body: JSON.stringify(buildUpdatePayload({ imagePath: finalImagePath })),
      });
      if (!putRes.ok) {
        const data = await putRes.json().catch(() => null);
        throw new Error(data?.error || (await describeAccountError(putRes)));
      }

      // ── Step 4: Publish if requested ──────────────────────────────────────
      if (publish && status !== 'published') {
        const pubRes = await mutate(`/api/projects/${currentId}/publish/`, {
          method: 'POST',
          body: '{}',
        });
        const pubData = await pubRes.json().catch(() => null);
        if (!pubRes.ok) {
          // The server returns all blockers at once. Render them field-by-field.
          if (pubData?.blockers) {
            const fieldErr: Record<string, string> = {};
            for (const blocker of pubData.blockers as PublishBlocker[]) {
              fieldErr[blocker.field] = blocker.message;
            }
            setFieldErrors(fieldErr);
            setError('Some required fields are missing. See the highlighted fields above.');
            return;
          }
          throw new Error(pubData?.error || (await describeAccountError(pubRes)));
        }
        setStatus('published');
        setSuccessUrl(`/projects/${pubData?.slug ?? currentSlug}/`);
      } else if (!publish && status === 'published') {
        // "Save changes" on a published project — just update, don't archive.
        // Archiving is explicit via the archive action.
      } else if (publish && status === 'published') {
        // Update published project — PUT already done above.
        setSuccessUrl(`/projects/${currentSlug}/`);
      }
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong.');
    } finally {
      setLoading(null);
    }
  };

  const handleArchive = async () => {
    if (!id) return;
    setLoading('archive');
    setError('');
    try {
      const res = await mutate(`/api/projects/${id}/archive/`, { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(await describeAccountError(res));
      setStatus('archived');
      setSuccessUrl(undefined);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(null);
    }
  };

  const handleRestore = async () => {
    if (!id) return;
    setLoading('restore');
    setError('');
    try {
      const res = await mutate(`/api/projects/${id}/restore/`, { method: 'POST', body: '{}' });
      if (!res.ok) throw new Error(await describeAccountError(res));
      setStatus('draft');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(null);
    }
  };

  const isLoading = loading !== null;

  return (
    <div className="pe">
      {/* ── Status + Public Link ─────────────────────────────────────────── */}
      <div className="pe-status-bar">
        <span className={`pe-badge pe-badge--${status}`}>
          {status === 'published' ? 'Published' : status === 'archived' ? 'Archived' : 'Draft'}
        </span>
        {successUrl && (
          <a className="pe-public-link" href={successUrl} target="_blank" rel="noopener">
            View public page →
          </a>
        )}
      </div>

      {error && <div className="pe-error">{error}</div>}

      {/* ── Basics ──────────────────────────────────────────────────────── */}
      <section className="pe-section">
        <h2 className="pe-section-head">Basics</h2>

        <div className={`pe-field${fieldErrors.title ? ' pe-field--error' : ''}`}>
          <label className="pe-label" htmlFor="pe-title">
            Project name <span className="pe-req">required</span>
          </label>
          <input
            className="pe-input"
            id="pe-title"
            name="title"
            type="text"
            value={form.title}
            onChange={handleChange}
            placeholder="What did you build?"
          />
          {fieldErrors.title && <p className="pe-field-error">{fieldErrors.title}</p>}
        </div>

        <div className={`pe-field${fieldErrors.summary ? ' pe-field--error' : ''}`}>
          <label className="pe-label" htmlFor="pe-summary">
            Tagline <span className="pe-req">required</span>
          </label>
          <input
            className="pe-input"
            id="pe-summary"
            name="summary"
            type="text"
            value={form.summary}
            onChange={handleChange}
            placeholder="One sentence that describes it."
            maxLength={300}
          />
          {fieldErrors.summary && <p className="pe-field-error">{fieldErrors.summary}</p>}
        </div>

        <div className="pe-row">
          <div className={`pe-field${fieldErrors.category ? ' pe-field--error' : ''}`}>
            <label className="pe-label" htmlFor="pe-category">
              Category
            </label>
            <select
              className="pe-input"
              id="pe-category"
              name="category"
              value={form.category}
              onChange={handleChange}
            >
              <option value="product">Product</option>
              <option value="agent">Agent</option>
              <option value="developer-tool">Developer Tool</option>
              <option value="research">Research</option>
              <option value="creative">Creative</option>
              <option value="campus">Campus</option>
              <option value="experiment">Experiment</option>
              <option value="startup">Startup</option>
            </select>
          </div>

          <div className={`pe-field${fieldErrors.cityId ? ' pe-field--error' : ''}`}>
            <label className="pe-label" htmlFor="pe-city">
              City <span className="pe-req">required to publish</span>
            </label>
            <select
              className="pe-input"
              id="pe-city"
              name="cityId"
              value={form.cityId}
              onChange={handleChange}
            >
              <option value="">Choose a city…</option>
              {cityOptions.length === 0 ? (
                <option value="" disabled>Loading cities…</option>
              ) : (
                cityOptions.map((city) => (
                  <option key={city.id} value={city.id}>
                    {city.name}
                  </option>
                ))
              )}
            </select>
            {fieldErrors.cityId && <p className="pe-field-error">{fieldErrors.cityId}</p>}
          </div>
        </div>
      </section>

      {/* ── Story ───────────────────────────────────────────────────────── */}
      <section className="pe-section">
        <h2 className="pe-section-head">Project story</h2>

        <div className={`pe-field${fieldErrors.description ? ' pe-field--error' : ''}`}>
          <label className="pe-label" htmlFor="pe-description">
            What it does <span className="pe-req">required to publish</span>
          </label>
          <textarea
            className="pe-input pe-textarea"
            id="pe-description"
            name="description"
            rows={5}
            value={form.description}
            onChange={handleChange}
            placeholder="Describe the project in detail. What problem does it solve? Who is it for?"
          />
          {fieldErrors.description && <p className="pe-field-error">{fieldErrors.description}</p>}
        </div>

        <div className={`pe-field${fieldErrors.claudeUsage ? ' pe-field--error' : ''}`}>
          <label className="pe-label" htmlFor="pe-claude-usage">
            How Claude was used <span className="pe-req">required to publish</span>
          </label>
          <textarea
            className="pe-input pe-textarea"
            id="pe-claude-usage"
            name="claudeUsage"
            rows={4}
            value={form.claudeUsage}
            onChange={handleChange}
            placeholder="The interesting part: what did Claude actually do in this project?"
          />
          {fieldErrors.claudeUsage && <p className="pe-field-error">{fieldErrors.claudeUsage}</p>}
        </div>
      </section>

      {/* ── Cover ───────────────────────────────────────────────────────── */}
      <section className="pe-section">
        <h2 className="pe-section-head">Cover image</h2>
        <p className="pe-hint">Optional. JPEG, PNG, WebP or AVIF. Max 5 MB.</p>

        {coverPreview && (
          <div className="pe-cover-preview">
            <img src={coverPreview} alt="Cover preview" />
            <button
              type="button"
              className="pe-cover-remove"
              onClick={() => {
                setCoverPreview(null);
                setFile(null);
                setForm((prev) => ({ ...prev, imagePath: '' }));
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            >
              Remove
            </button>
          </div>
        )}

        {uploadProgress && <p className="pe-upload-progress">{uploadProgress}</p>}

        {!id && (
          <p className="pe-hint pe-hint--notice">
            Save a draft first to enable image upload.
          </p>
        )}

        <input
          ref={fileInputRef}
          type="file"
          id="pe-image"
          className="pe-file-input"
          accept="image/jpeg,image/png,image/webp,image/avif"
          disabled={!id}
          onChange={handleFileChange}
        />
        <label htmlFor="pe-image" className={`pe-file-label${!id ? ' pe-file-label--disabled' : ''}`}>
          {coverPreview ? 'Replace cover' : 'Choose cover'}
        </label>
      </section>

      {/* ── Links ───────────────────────────────────────────────────────── */}
      <section className="pe-section">
        <h2 className="pe-section-head">Links</h2>

        <div className="pe-field">
          <label className="pe-label" htmlFor="pe-url">
            Demo URL
          </label>
          <input
            className="pe-input"
            id="pe-url"
            name="url"
            type="url"
            value={form.url}
            onChange={handleChange}
            placeholder="https://…"
          />
        </div>

        <div className="pe-field">
          <label className="pe-label" htmlFor="pe-repo-url">
            Repository URL
          </label>
          <input
            className="pe-input"
            id="pe-repo-url"
            name="repoUrl"
            type="url"
            value={form.repoUrl}
            onChange={handleChange}
            placeholder="https://github.com/…"
          />
        </div>

        <div className="pe-field">
          <label className="pe-label" htmlFor="pe-video-url">
            Demo video URL
          </label>
          <input
            className="pe-input"
            id="pe-video-url"
            name="videoUrl"
            type="url"
            value={form.videoUrl}
            onChange={handleChange}
            placeholder="https://youtube.com/…"
          />
        </div>
      </section>

      {/* ── Actions ─────────────────────────────────────────────────────── */}
      <section className="pe-section pe-actions-section">
        {status === 'archived' ? (
          <button
            type="button"
            className="pe-btn pe-btn--secondary"
            onClick={handleRestore}
            disabled={isLoading}
          >
            {loading === 'restore' ? 'Restoring…' : 'Restore draft'}
          </button>
        ) : status === 'published' ? (
          <>
            <button
              type="button"
              className="pe-btn pe-btn--primary"
              onClick={() => handleSave(true)}
              disabled={isLoading}
            >
              {loading === 'publish' ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              className="pe-btn pe-btn--secondary"
              onClick={() => handleSave(false)}
              disabled={isLoading}
            >
              {loading === 'save' ? 'Saving…' : 'Save without republishing'}
            </button>
            <button
              type="button"
              className="pe-btn pe-btn--danger"
              onClick={handleArchive}
              disabled={isLoading}
            >
              {loading === 'archive' ? 'Archiving…' : 'Archive project'}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="pe-btn pe-btn--primary"
              onClick={() => handleSave(true)}
              disabled={isLoading}
            >
              {loading === 'publish' ? 'Publishing…' : 'Publish project'}
            </button>
            <button
              type="button"
              className="pe-btn pe-btn--secondary"
              onClick={() => handleSave(false)}
              disabled={isLoading}
            >
              {loading === 'save' ? 'Saving…' : 'Save draft'}
            </button>
          </>
        )}

        {successUrl && status === 'published' && (
          <a className="pe-view-link" href={successUrl} target="_blank" rel="noopener">
            View public project →
          </a>
        )}
      </section>

      <style>{`
        .pe {
          display: flex;
          flex-direction: column;
          gap: 0;
          font-family: var(--font-sans);
        }

        /* Status bar */
        .pe-status-bar {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin-bottom: 2rem;
          flex-wrap: wrap;
        }
        .pe-badge {
          display: inline-flex;
          align-items: center;
          padding: 0.25rem 0.75rem;
          font-family: var(--font-mono);
          font-size: 0.7rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          border-radius: 2px;
          border: 1px solid currentColor;
        }
        .pe-badge--draft {
          color: var(--ink-3);
          border-color: var(--rule);
          background: var(--paper-sunk);
        }
        .pe-badge--published {
          color: #166534;
          border-color: #bbf7d0;
          background: #f0fdf4;
        }
        .pe-badge--archived {
          color: var(--ink-3);
          border-color: var(--rule);
          background: var(--wash, #f3f4f6);
          text-decoration: line-through;
        }
        .pe-public-link {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          color: var(--clay-deep, #92400e);
          text-decoration: none;
          letter-spacing: 0.03em;
        }
        .pe-public-link:hover { text-decoration: underline; }

        /* Error banner */
        .pe-error {
          padding: 0.875rem 1rem;
          margin-bottom: 1.5rem;
          background: #fff1f0;
          border: 1px solid #ffa39e;
          border-left: 3px solid #ff4d4f;
          color: #a8071a;
          font-size: 0.9rem;
          line-height: 1.5;
        }

        /* Sections */
        .pe-section {
          padding: 1.5rem 0;
          border-top: 1px solid var(--rule);
        }
        .pe-section:first-of-type { border-top: none; padding-top: 0; }

        .pe-section-head {
          font-family: var(--font-mono);
          font-size: 0.7rem;
          font-weight: 500;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--ink-3);
          margin-bottom: 1.25rem;
        }

        /* Fields */
        .pe-field {
          margin-bottom: 1.25rem;
        }
        .pe-field:last-child { margin-bottom: 0; }
        .pe-field--error .pe-input {
          border-color: #ff4d4f;
          background: #fff1f0;
        }
        .pe-field-error {
          margin-top: 0.35rem;
          font-size: 0.8rem;
          color: #a8071a;
          font-family: var(--font-mono);
        }

        .pe-label {
          display: block;
          font-size: 0.85rem;
          font-weight: 500;
          color: var(--ink-2);
          margin-bottom: 0.4rem;
        }
        .pe-req {
          font-weight: 400;
          color: var(--ink-3);
          font-size: 0.75rem;
          font-family: var(--font-mono);
          margin-left: 0.25rem;
        }

        .pe-input {
          display: block;
          width: 100%;
          padding: 0.7rem 0.875rem;
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
          min-height: 5rem;
          line-height: 1.6;
        }

        .pe-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1rem;
        }
        @media (max-width: 37.99em) {
          .pe-row { grid-template-columns: 1fr; }
        }

        .pe-hint {
          margin-bottom: 0.75rem;
          font-size: 0.8rem;
          color: var(--ink-3);
          font-family: var(--font-mono);
        }
        .pe-hint--notice {
          color: var(--clay, #b45309);
        }

        /* Cover preview */
        .pe-cover-preview {
          position: relative;
          width: 100%;
          max-width: 320px;
          margin-bottom: 1rem;
          border: 1px solid var(--rule);
          border-radius: 2px;
          overflow: hidden;
        }
        .pe-cover-preview img {
          display: block;
          width: 100%;
          height: auto;
          max-height: 180px;
          object-fit: cover;
        }
        .pe-cover-remove {
          position: absolute;
          top: 0.5rem;
          right: 0.5rem;
          padding: 0.2rem 0.5rem;
          font-size: 0.7rem;
          font-family: var(--font-mono);
          letter-spacing: 0.05em;
          text-transform: uppercase;
          background: rgba(0,0,0,0.65);
          color: #fff;
          border: none;
          cursor: pointer;
          border-radius: 2px;
        }

        .pe-upload-progress {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          color: var(--clay, #b45309);
          margin-bottom: 0.75rem;
        }

        /* File input */
        .pe-file-input {
          position: absolute;
          opacity: 0;
          pointer-events: none;
          width: 0;
          height: 0;
        }
        .pe-file-label {
          display: inline-flex;
          align-items: center;
          padding: 0.5rem 1rem;
          font-family: var(--font-mono);
          font-size: 0.75rem;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          border: 1px solid var(--rule);
          border-radius: 2px;
          cursor: pointer;
          color: var(--ink);
          background: var(--paper);
          transition: border-color 0.15s, background 0.15s;
        }
        .pe-file-label:hover:not(.pe-file-label--disabled) {
          border-color: var(--ink);
          background: var(--shade-1, #f9fafb);
        }
        .pe-file-label--disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        /* Actions */
        .pe-actions-section {
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
          transition: background 0.15s, border-color 0.15s, color 0.15s;
        }
        .pe-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
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
        .pe-btn--danger {
          background: var(--paper);
          color: #a8071a;
          border-color: #ffa39e;
        }
        .pe-btn--danger:hover:not(:disabled) {
          background: #fff1f0;
        }

        .pe-view-link {
          font-family: var(--font-mono);
          font-size: 0.75rem;
          color: var(--clay-deep, #92400e);
          text-decoration: none;
          letter-spacing: 0.03em;
          margin-left: auto;
        }
        .pe-view-link:hover { text-decoration: underline; }
      `}</style>
    </div>
  );
}
