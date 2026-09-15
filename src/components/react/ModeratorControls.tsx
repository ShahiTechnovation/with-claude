import { useState } from 'react';

interface ModeratorControlsProps {
  entityType: 'builders' | 'projects';
  entityId: string;
  initialState: string;
}

export function ModeratorControls({ entityType, entityId, initialState }: ModeratorControlsProps) {
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState(initialState);
  
  const isHidden = state === 'restricted' || state === 'removed';

  const handleAction = async (action: 'hide' | 'restore' | 'remove') => {
    if (!confirm(`Are you sure you want to ${action} this ${entityType.slice(0, -1)}?`)) return;
    
    setLoading(true);
    try {
      const res = await fetch(`/api/moderation/${entityType}/${entityId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      
      if (res.ok) {
        if (action === 'hide') setState('restricted');
        if (action === 'remove') setState('removed');
        if (action === 'restore') setState('clean');
        // Reload to update the banner immediately
        window.location.reload();
      } else {
        const err = await res.json();
        alert(`Failed to ${action}: ${err.error}`);
      }
    } catch (err) {
      alert(`Error: ${err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '16px', background: 'var(--ink-5, #f5f5f5)', borderRadius: '8px', border: '1px solid var(--rule)', marginTop: '24px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 'bold', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Moderator Controls</h3>
      <p style={{ fontSize: '13px', marginBottom: '12px' }}>Current State: <strong>{state}</strong></p>
      
      <div style={{ display: 'flex', gap: '8px' }}>
        {isHidden ? (
          <button 
            disabled={loading} 
            onClick={() => handleAction('restore')}
            style={{ padding: '6px 12px', background: '#000', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
          >
            {loading ? 'Processing...' : 'Restore'}
          </button>
        ) : (
          <button 
            disabled={loading} 
            onClick={() => handleAction('hide')}
            style={{ padding: '6px 12px', background: '#e00', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
          >
            {loading ? 'Processing...' : 'Hide (Restrict)'}
          </button>
        )}
        
        {state !== 'removed' && (
          <button 
            disabled={loading} 
            onClick={() => handleAction('remove')}
            style={{ padding: '6px 12px', background: '#900', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
          >
            {loading ? 'Processing...' : 'Remove (Delete)'}
          </button>
        )}
      </div>
    </div>
  );
}
