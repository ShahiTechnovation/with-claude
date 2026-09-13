import { useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { cities } from '@/data/cities';

export default function ProfileEditor({ profile }: { profile: any }) {
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
    visibility: profile.visibility ?? 'public' 
  });
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const save = async () => { 
    setStatus('saving');
    try {
      const token = await getAccessToken();
      const response = await fetch('/api/member/profile/', { 
        method: 'PATCH', 
        headers: { 
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }, 
        body: JSON.stringify(form) 
      }); 
      if (!response.ok) { 
        setStatus('error');
        setMessage('Could not save changes.'); 
        return; 
      } 
      setStatus('success');
      setMessage('Changes saved.'); 
      window.location.assign('/me/profile/');
    } catch (e) {
      setStatus('error');
      setMessage('Network error while saving.');
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
          <input value={form.primaryRole} onChange={(e) => setForm({ ...form, primaryRole: e.target.value })} />
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
