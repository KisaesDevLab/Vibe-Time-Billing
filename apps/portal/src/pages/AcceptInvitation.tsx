// SPDX-License-Identifier: Elastic-2.0
//
// Portal invitation acceptance page. Reached via the magic link in the
// invitation email (or SMS) — e.g. portal.firm.com/auth/accept?token=...
//
// Posts the raw token to /api/portal/auth/accept-invitation which
// looks the invitation up by SHA-256(token), promotes the
// client_portal_access row to ACTIVE, marks the invitation USED, and
// issues a __vibe_portal_session cookie. We then refresh /me and
// navigate to the portal home.

import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';

export function AcceptInvitationPage(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    if (!token) {
      setError('No invitation token in URL. Reopen the link from your invitation email.');
      return;
    }
    void (async () => {
      try {
        await api('/api/portal/auth/accept-invitation', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        await refresh();
        navigate('/', { replace: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'accept_failed';
        if (msg === 'invalid_token') {
          setError('This invitation link is invalid. Ask your CPA to resend the invitation.');
        } else if (msg === 'invitation_expired') {
          setError('This invitation has expired. Ask your CPA to resend it.');
        } else if (msg === 'invitation_already_used') {
          setError(
            'This invitation has already been accepted. Sign in with your email to continue.',
          );
        } else {
          setError(`We could not accept the invitation (${msg}). Try again or contact your CPA.`);
        }
      }
    })();
  }, [location.search, navigate, refresh]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: tokens.color.text,
        fontFamily: tokens.font.body,
        background: tokens.color.bg,
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 460 }}>
        {error ? (
          <>
            <h1 style={{ fontSize: 18, marginBottom: 8 }}>Invitation problem</h1>
            <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>{error}</p>
          </>
        ) : (
          <p style={{ color: tokens.color.textMuted, fontSize: 14 }}>Accepting your invitation…</p>
        )}
      </div>
    </div>
  );
}
