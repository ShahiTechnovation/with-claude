import { useState } from 'react';

interface ModeratorControlsProps {
  entityType: 'builders' | 'projects';
  entityId: string;
  initialState: string;
}

export function ModeratorControls({ entityType, entityId, initialState }: ModeratorControlsProps) {
  const [loading, setLoading] = useState(false);

  const isHidden = initialState === 'restricted' || initialState === 'removed';

  const handleAction = async (action: 'hide' | 'restore' | 'remove') => {
    if (!confirm(`Are you sure you want to ${action} this ${entityType.slice(0, -1)}?`)) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/moderation/${entityType}/${entityId}/`, {
        credentials: 'same-origin',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      if (res.ok) {
        // Reload to update the banner. The buttons stay disabled until the page goes.
        window.location.reload();
        return;
      }
      // A 500 is not guaranteed to be JSON.
      const body = await res.json().catch(() => ({}));
      console.error(`[moderator] ${action} failed`, res.status, body.error);
      alert(`Failed to ${action} (${res.status})${body.error ? `: ${body.error}` : ''}`);
    } catch (err) {
      console.error(`[moderator] ${action} failed`, err);
      alert('We could not reach the server. Try again.');
    }
    setLoading(false);
  };

  return (
    <div className="panel" style={{ marginTop: 'var(--s-5)', width: '100%' }}>
      <div className="panel-head">
        <h3>Moderator Controls</h3>
      </div>
      <p className="panel-hint">
        Current State: <strong>{initialState}</strong>
      </p>

      <div className="form-actions">
        {isHidden ? (
          <button
            type="button"
            className="button button--primary"
            disabled={loading}
            onClick={() => handleAction('restore')}
          >
            {loading ? 'Processing...' : 'Restore'}
          </button>
        ) : (
          <button
            type="button"
            className="button"
            disabled={loading}
            onClick={() => handleAction('hide')}
          >
            {loading ? 'Processing...' : 'Hide (Restrict)'}
          </button>
        )}

        {initialState !== 'removed' && (
          <button
            type="button"
            className="button button--danger"
            disabled={loading}
            onClick={() => handleAction('remove')}
          >
            {loading ? 'Processing...' : 'Remove (Delete)'}
          </button>
        )}
      </div>
    </div>
  );
}
