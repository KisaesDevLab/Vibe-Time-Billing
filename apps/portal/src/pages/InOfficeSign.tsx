// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Public in-office signing landing. A printed QR points here with a per-signer
// token. Step 1: verify the signer — for a KBA-gated 1040 the preparer records
// the in-person government photo-ID check (Pub 1345, which replaces KBA); for
// entity returns the signer just confirms who they are. Step 2: we redirect to
// the actual signing screen (the signing URL the verify call returns).

import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';

import { AuthLayout, Button, tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';

interface Meta {
  signerName: string;
  documentTitle: string;
  formType: string | null;
  requiresAttestation: boolean;
  signerStatus: string;
  requestStatus: string;
  terminal: boolean;
}

const ID_TYPES = [
  { value: '', label: 'Select ID type…' },
  { value: 'drivers_license', label: 'Driver’s license' },
  { value: 'state_id', label: 'State ID' },
  { value: 'passport', label: 'Passport' },
  { value: 'military_id', label: 'Military ID' },
  { value: 'other', label: 'Other' },
];

export function InOfficeSignPage(): JSX.Element {
  const { token = '' } = useParams();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [idType, setIdType] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<Meta>(`/api/public/in-office/${token}`)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setLoadErr(
            (e as ApiError)?.status === 404
              ? 'This link is invalid or has expired.'
              : 'load_failed',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const ready = meta ? (meta.requiresAttestation ? Boolean(idType) && verified : verified) : false;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ signingUrl: string }>(`/api/public/in-office/${token}/verify`, {
        method: 'POST',
        body: JSON.stringify(meta?.requiresAttestation ? { idType } : {}),
      });
      // Hand off to the signing screen.
      window.location.href = r.signingUrl;
    } catch (err) {
      const code = (err as ApiError)?.body
        ? String(((err as ApiError).body as { error?: string }).error ?? '')
        : '';
      setError(
        code === 'identity_required'
          ? 'Please record the photo-ID check before continuing.'
          : code === 'request_terminal'
            ? 'This signing is already complete or no longer available.'
            : code === 'signing_unavailable'
              ? 'Signing is temporarily unavailable. Please ask the firm for help.'
              : 'Could not start signing. Please try again or ask the firm for help.',
      );
      setBusy(false);
    }
  }

  if (loadErr) {
    return (
      <AuthLayout brand="Client Portal" title="In-office signing">
        <p style={{ fontSize: 14, color: tokens.color.danger }}>{loadErr}</p>
      </AuthLayout>
    );
  }
  if (!meta) {
    return (
      <AuthLayout brand="Client Portal" title="In-office signing">
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>Loading…</p>
      </AuthLayout>
    );
  }
  if (meta.terminal) {
    return (
      <AuthLayout brand="Client Portal" title="In-office signing">
        <p style={{ fontSize: 14 }}>This signing is already complete or no longer available.</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout brand="Client Portal" title="In-office signing">
      <form onSubmit={(e) => void onSubmit(e)} style={{ display: 'grid', gap: tokens.space.md }}>
        <div style={{ fontSize: 14 }}>
          <div style={{ color: tokens.color.textMuted }}>Signer</div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>{meta.signerName}</div>
          <div style={{ color: tokens.color.textMuted, marginTop: 4 }}>{meta.documentTitle}</div>
        </div>

        {meta.requiresAttestation ? (
          <>
            <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
              Before this taxpayer signs Form 8879, the preparer must verify their government photo
              ID in person (IRS requirement).
            </div>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              Photo ID type
              <select
                value={idType}
                onChange={(e) => setIdType(e.target.value)}
                style={{
                  fontSize: 14,
                  padding: '8px 10px',
                  borderRadius: tokens.radius.sm,
                  border: `1px solid ${tokens.color.border}`,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              >
                {ID_TYPES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={verified}
                onChange={(e) => setVerified(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              I verified this person’s government photo ID in person.
            </label>
          </>
        ) : (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            I confirm I am {meta.signerName}.
          </label>
        )}

        {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}

        <Button type="submit" disabled={!ready || busy}>
          {busy ? 'Starting…' : 'Continue to sign'}
        </Button>
      </form>
    </AuthLayout>
  );
}
