// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import QRCode from 'qrcode';

import { AuthLayout, Button, Input, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';
import { BRAND } from '../brand';

interface EnrollmentResponse {
  otpauthUri: string;
  recoveryCodes: string[];
}

export function TotpEnrollPage(): JSX.Element {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [enrollment, setEnrollment] = useState<EnrollmentResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<EnrollmentResponse>('/api/auth/totp/enroll', { method: 'POST' });
        setEnrollment(r);
        const dataUrl = await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 224 });
        setQrDataUrl(dataUrl);
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
      <AuthLayout brand={BRAND} title="Setting up TOTP…">
        <p style={{ fontSize: 14 }}>Loading…</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      brand={BRAND}
      title="Two-factor enrollment"
      subtitle="TOTP is required for all staff. Scan in your authenticator app."
    >
      {enrollment && (
        <>
          {qrDataUrl && (
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
              <img
                src={qrDataUrl}
                alt="TOTP enrollment QR code"
                width={224}
                height={224}
                style={{ borderRadius: 6, background: '#fff', padding: 8 }}
              />
            </div>
          )}
          <details style={{ marginBottom: 8, fontSize: 12 }}>
            <summary>Can&apos;t scan? Show setup URI</summary>
            <pre
              style={{
                fontSize: 11,
                wordBreak: 'break-all',
                whiteSpace: 'pre-wrap',
                background: tokens.color.surface,
                padding: 8,
                borderRadius: 6,
                marginTop: 8,
              }}
            >
              {enrollment.otpauthUri}
            </pre>
          </details>
          <details style={{ marginTop: 12, fontSize: 13 }}>
            <summary>Recovery codes (save now)</summary>
            <ul style={{ paddingLeft: 18, marginTop: 8, fontFamily: tokens.font.mono }}>
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
            {error && <div style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</div>}
            <Button type="submit" disabled={submitting || !acknowledged}>
              {submitting ? 'Verifying…' : 'Verify & finish'}
            </Button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
