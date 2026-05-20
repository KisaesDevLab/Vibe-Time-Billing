// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { AuthLayout, Button, Input } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';

interface EnrollmentResponse {
  otpauthUri: string;
  recoveryCodes: string[];
}

export function TotpEnrollPage(): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [enrollment, setEnrollment] = useState<EnrollmentResponse | null>(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<EnrollmentResponse>('/api/auth/totp/enroll', { method: 'POST' });
        setEnrollment(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'enrollment failed');
      }
    })();
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api('/api/auth/totp/verify', { method: 'POST', body: JSON.stringify({ code }) });
      await refresh();
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!enrollment && !error) {
    return (
      <AuthLayout brand="Vibe Time & Billing" title="Setting up TOTP…">
        <p style={{ fontSize: 14 }}>Loading…</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      brand="Vibe Time & Billing"
      title="Two-factor enrollment"
      subtitle="TOTP is required for all staff. Scan in your authenticator app."
    >
      {enrollment && (
        <>
          <pre
            style={{
              fontSize: 11,
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap',
              background: '#11151b',
              padding: 8,
              borderRadius: 6,
            }}
          >
            {enrollment.otpauthUri}
          </pre>
          <details style={{ marginTop: 12, fontSize: 13 }}>
            <summary>Recovery codes (save now)</summary>
            <ul style={{ paddingLeft: 18, marginTop: 8, fontFamily: 'monospace' }}>
              {enrollment.recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span style={{ fontSize: 12 }}>I have saved these codes.</span>
            </label>
          </details>
          <form onSubmit={submit} style={{ display: 'grid', gap: 12, marginTop: 16 }}>
            <Input
              label="6-digit code from your authenticator"
              inputMode="numeric"
              pattern="[0-9 ]*"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              required
            />
            {error && <div style={{ color: '#ef4444', fontSize: 12 }}>{error}</div>}
            <Button type="submit" disabled={submitting || !acknowledged}>
              {submitting ? 'Verifying…' : 'Verify & finish'}
            </Button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
