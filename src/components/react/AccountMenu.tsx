import { PrivyProvider, usePrivy } from '@privy-io/react-auth';
import { useState, useRef, useEffect } from 'react';

function Inner() {
  const { ready, authenticated, logout } = usePrivy();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!ready || !authenticated) {
    return (
      <div className="account-slot" data-account-state="anonymous">
        <a className="account-join" href="/join/">
          Join<span className="account-join-full"> WITH CLAUDE</span>
        </a>
      </div>
    );
  }

  return (
    <div className="account-slot" data-account-state="signed-in" ref={menuRef} style={{ position: 'relative' }}>
      <button 
        className="account-link" 
        onClick={() => setOpen(!open)}
        aria-label="Account menu"
        aria-expanded={open}
      >
        <span className="account-badge" aria-hidden="true">ME</span>
        <span className="account-name">Account</span>
      </button>

      {open && (
        <div className="account-menu-dropdown">
          <a href="/me/">Profile</a>
          <a href="/me/projects/">Projects</a>
          <a href="/me/settings/">Settings</a>
          <button type="button" onClick={() => void logout()}>Sign out</button>
        </div>
      )}
    </div>
  );
}

interface Props {
  appId: string;
}

export default function AccountMenu({ appId }: Props) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        embeddedWallets: {
          ethereum: { createOnLogin: 'off' },
          solana: { createOnLogin: 'off' },
        },
        appearance: { theme: 'light' },
      }}
    >
      <Inner />
    </PrivyProvider>
  );
}
