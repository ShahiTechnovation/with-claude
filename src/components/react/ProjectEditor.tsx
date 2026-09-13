import React, { useState } from 'react';
import { upload } from '@vercel/blob/client';
import { usePrivy } from '@privy-io/react-auth';
import { accountFetch, describeAccountError } from '@/lib/account-fetch';

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

export default function ProjectEditor({ initialData = {} }: { initialData?: InitialData }) {
  const { getAccessToken } = usePrivy();
  const [formData, setFormData] = useState({
    title: initialData.title || '',
    summary: initialData.summary || '',
    description: initialData.description || '',
    claudeUsage: initialData.claudeUsage || '',
    cityId: initialData.cityId || '',
    category: initialData.category || 'product',
    url: initialData.url || '',
    repoUrl: initialData.repoUrl || '',
    videoUrl: initialData.videoUrl || '',
    imagePath: initialData.imagePath || '',
  });

  const [id, setId] = useState(initialData.id);
  const [status, setStatus] = useState(initialData.publicationStatus || 'draft');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);

  /**
   * A mutation to this project's own API, via `accountFetch`.
   *
   * This used to build its own `Authorization` header with a local
   * `authHeaders()` helper that called `await getAccessToken()` directly and
   * threw if it came back falsy. It never got that far: `ProjectEditor` is
   * mounted as its own island (`client:only="react"`, outside the site's one
   * `PrivyProvider` — see `src/lib/account-fetch.ts`), so `getAccessToken`
   * THROWS synchronously every time it is called here, with the message
   * "You need to wrap your application with the <PrivyProvider>…". That
   * throw propagated straight out of `authHeaders()`, past every call site,
   * into `catch (err: any) { setError(err.message) }` — so every save,
   * publish, archive and restore showed that raw SDK internal-error string
   * to the person using the site.
   *
   * URLs also now carry the trailing slash every other route on this site
   * uses (`trailingSlash: 'always'` in `astro.config.mjs`); without it each
   * of these was a needless 308 redirect that a browser's `fetch()` does
   * follow correctly, but there is no reason to pay for a hop that costs
   * nothing to avoid.
   */
  const mutate = (path: string, init: RequestInit) =>
    accountFetch(
      path,
      { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } },
      getAccessToken,
    );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSave = async (publish: boolean) => {
    setLoading(true);
    setError('');
    setMessage('');

    try {
      let currentId = id;

      // Upload file if selected
      let finalImagePath = formData.imagePath;
      if (file) {
        const newBlob = await upload(file.name, file, {
          access: 'public',
          handleUploadUrl: '/api/media/upload',
        });
        finalImagePath = newBlob.url;
        setFormData((prev) => ({ ...prev, imagePath: finalImagePath }));
      }

      const payload = {
        ...formData,
        imagePath: finalImagePath,
      };

      if (!currentId) {
        // Create draft
        const res = await mutate('/api/projects/', { method: 'POST', body: JSON.stringify(payload) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || (await describeAccountError(res)));
        currentId = data.id;
        setId(data.id);
        window.history.replaceState({}, '', `/me/projects/${data.id}/edit/`);
      } else {
        // Update existing
        const res = await mutate(`/api/projects/${currentId}/`, { method: 'PUT', body: JSON.stringify(payload) });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || (await describeAccountError(res)));
        }
      }

      if (publish && status !== 'published') {
        const res = await mutate(`/api/projects/${currentId}/publish/`, { method: 'POST', body: '{}' });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || (await describeAccountError(res)));
        }
        setStatus('published');
        setMessage('Project published successfully!');
      } else if (!publish && status === 'published') {
        const res = await mutate(`/api/projects/${currentId}/archive/`, { method: 'POST', body: '{}' });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || (await describeAccountError(res)));
        }
        setStatus('archived');
        setMessage('Project archived.');
      } else {
        setMessage('Project saved as draft.');
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const restoreDraft = async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const response = await mutate(`/api/projects/${id}/restore/`, { method: 'POST', body: '{}' });
      if (!response.ok) throw new Error(await describeAccountError(response));
      setStatus('draft');
      setMessage('Project restored to drafts.');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="project-editor">
      {error && <div className="error-banner">{error}</div>}
      {message && <div className="success-banner">{message}</div>}

      <div className="form-group">
        <label htmlFor="title">Name (Required)</label>
        <input type="text" name="title" id="title" value={formData.title} onChange={handleChange} required />
      </div>

      <div className="form-group">
        <label htmlFor="summary">Tagline (Required)</label>
        <input type="text" name="summary" id="summary" value={formData.summary} onChange={handleChange} required />
      </div>

      <div className="form-group">
        <label htmlFor="description">What it does (Required)</label>
        <textarea name="description" id="description" rows={5} value={formData.description} onChange={handleChange} required />
      </div>

      <div className="form-group">
        <label htmlFor="claudeUsage">How Claude was used (Required)</label>
        <textarea name="claudeUsage" id="claudeUsage" rows={3} value={formData.claudeUsage} onChange={handleChange} required />
      </div>

      <div className="form-group">
        <label htmlFor="category">Category (Required)</label>
        <select name="category" id="category" value={formData.category} onChange={handleChange} required>
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

      {/* Advanced toggle */}
      <button type="button" className="toggle-advanced" onClick={() => setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? 'Hide Advanced Settings' : 'Show Advanced Settings'}
      </button>

      {showAdvanced && (
        <div className="advanced-fields">
          <div className="form-group">
            <label htmlFor="image">Cover Image</label>
            {formData.imagePath && <p>Current: {formData.imagePath}</p>}
            <input type="file" id="image" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </div>

          <div className="form-group">
            <label htmlFor="url">Demo URL</label>
            <input type="url" name="url" id="url" value={formData.url} onChange={handleChange} />
          </div>

          <div className="form-group">
            <label htmlFor="repoUrl">Repository URL</label>
            <input type="url" name="repoUrl" id="repoUrl" value={formData.repoUrl} onChange={handleChange} />
          </div>

          <div className="form-group">
            <label htmlFor="videoUrl">Video URL</label>
            <input type="url" name="videoUrl" id="videoUrl" value={formData.videoUrl} onChange={handleChange} />
          </div>
        </div>
      )}

      <div className="editor-actions">
        {status === 'archived' ? <button type="button" className="btn-secondary" onClick={restoreDraft} disabled={loading}>Restore draft</button> : <button type="button" className="btn-secondary" onClick={() => handleSave(false)} disabled={loading}>{status === 'published' ? 'Archive project' : 'Save draft'}</button>}
        <button type="button" className="btn-primary" onClick={() => handleSave(true)} disabled={loading}>
          {status === 'published' ? 'Update Published Project' : 'Publish Project'}
        </button>
      </div>

      <style>{`
        .project-editor {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          max-width: 600px;
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        .form-group label {
          font-weight: 500;
        }
        .form-group input, .form-group select, .form-group textarea {
          padding: 0.75rem;
          border: 1px solid var(--rule);
          background: var(--paper);
          color: var(--ink);
          font-family: inherit;
        }
        .toggle-advanced {
          background: none;
          border: none;
          color: var(--ink-2);
          text-decoration: underline;
          cursor: pointer;
          text-align: left;
          padding: 0;
          font-weight: 500;
        }
        .advanced-fields {
          padding: 1.5rem;
          background: var(--wash);
          border: 1px solid var(--rule);
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .editor-actions {
          display: flex;
          gap: 1rem;
          margin-top: 1rem;
        }
        .btn-primary, .btn-secondary {
          padding: 0.75rem 1.5rem;
          font-weight: 500;
          cursor: pointer;
          border: 1px solid var(--rule);
        }
        .btn-primary {
          background: var(--ink);
          color: var(--paper);
        }
        .btn-secondary {
          background: var(--paper);
          color: var(--ink);
        }
        .error-banner {
          padding: 1rem;
          background: #ffebe9;
          color: #cf222e;
          border: 1px solid #cf222e;
        }
        .success-banner {
          padding: 1rem;
          background: #e6f4ea;
          color: #1e8e3e;
          border: 1px solid #1e8e3e;
        }
      `}</style>
    </div>
  );
}
