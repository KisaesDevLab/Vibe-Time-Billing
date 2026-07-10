// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// TR-5 — Portal-side endpoint for the staff "view as client" link.
//
// The staff app navigates the browser to
//   https://portal.firm.com/auth/impersonate?token=<JWT>
// and this page exchanges the JWT for a __vibe_portal_session cookie
// via POST /api/portal/auth/impersonate-exchange. On success it kicks
// the auth context to re-fetch /me and redirects to /.
//
// CLAUDE.md non-negotiable #2 still holds: this never reuses the
// staff session; it mints a fresh portal session with its own cookie
// and signing key. The minted session is flagged isImpersonation,
// which makes it read-only and time-boxed (60 min soft TTL) on the
// server side. The banner in App.tsx surfaces the impersonator email.

import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';

export function ImpersonatePage(): JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    if (!token) {
      setError('No impersonation token in URL.');
      return;
    }
    void (async () => {
      try {
        await api('/api/portal/auth/impersonate-exchange', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        await refresh();
        navigate('/', { replace: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'exchange_failed';
        if (msg === 'invalid_token') {
          setError('This impersonation link has expired or already been used.');
        } else if (msg === 'access_inactive') {
          setError('Portal access for this client is no longer active.');
        } else if (msg === 'impersonation_not_configured') {
          setError('Impersonation is not enabled on this appliance.');
        } else {
          setError(`Could not start the view-as-client session (${msg}).`);
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
      <div style={{ textAlign: 'center', maxWidth: 420 }}>
        {error ? (
          <>
            <h1 style={{ fontSize: 18, marginBottom: 8 }}>Impersonation failed</h1>
            <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>{error}</p>
            <p style={{ color: tokens.color.textMuted, fontSize: 12, marginTop: 16 }}>
              Return to the staff app and try again.
            </p>
          </>
        ) : (
          <p style={{ color: tokens.color.textMuted, fontSize: 14 }}>
            Starting view-as-client session…
          </p>
        )}
      </div>
    </div>
  );
}
