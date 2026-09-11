import React, { useState } from 'react';
import { upload } from '@vercel/blob/client';

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
        setFormData(prev => ({ ...prev, imagePath: finalImagePath }));
      }

      const payload = {
        ...formData,
        imagePath: finalImagePath,
      };

      if (!currentId) {
        // Create draft
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create project');
        currentId = data.id;
        setId(data.id);
        window.history.replaceState({}, '', `/me/projects/${data.id}/edit`);
      } else {
        // Update existing
        const res = await fetch(`/api/projects/${currentId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to update project');
        }
      }

      if (publish && status !== 'published') {
        const res = await fetch(`/api/projects/${currentId}/publish`, {
          method: 'POST',
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to publish project');
        }
        setStatus('published');
        setMessage('Project published successfully!');
      } else if (!publish && status === 'published') {
        const res = await fetch(`/api/projects/${currentId}/archive`, {
          method: 'POST',
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to unpublish project');
        }
        setStatus('draft');
        setMessage('Project reverted to draft.');
      } else {
        setMessage('Project saved as draft.');
      }
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
        <button type="button" className="btn-secondary" onClick={() => handleSave(false)} disabled={loading}>
          {status === 'published' ? 'Unpublish to Draft' : 'Save Draft'}
        </button>
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
