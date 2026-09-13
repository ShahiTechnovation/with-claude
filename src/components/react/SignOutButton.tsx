import { usePrivy } from '@privy-io/react-auth';
import React from 'react';

export default function SignOutButton() {
  const { logout } = usePrivy();

  const handleSignOut = () => {
    void logout().then(() => window.location.assign('/'));
  };

  return (
    <button type="button" className="btn-secondary" onClick={handleSignOut}>
      Sign out
    </button>
  );
}
