// SPDX-License-Identifier: Elastic-2.0
//
// Shared in-office signing flow. Drives a single signature request through
// the in-person path: set it up (suppress email; for a KBA-gated 1040 8879
// record the in-person photo-ID attestation that replaces KBA per IRS Pub
// 1345), then print the per-signer QR sheet / hand over a device / refresh
// status. Used by both the Signatures detail page and the tax-return
// Signatures card so the two never diverge.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import QRCode from 'qrcode';
import { Button, Combobox, Pill, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';
import { usePermission } from '../../auth-context';
import { statusLabel, statusTone } from '../Signatures';

interface Signer {
  id: string;
  name: string;
  email: string;
  role: string | null;
  status: string;
  signingUrl?: string | null;
}
interface RequestDetail {
  id: string;
  status: string;
  signingMode: string;
  formType: string | null;
}
interface Placement {
  id: string;
}
interface DetailResponse {
  request: RequestDetail;
  signers: Signer[];
  placements: Placement[];
}

const ID_TYPE_OPTIONS = [
  { value: '', label: 'Select ID type…' },
  { value: 'drivers_license', label: 'Driver’s license' },
  { value: 'state_id', label: 'State ID' },
  { value: 'passport', label: 'Passport' },
  { value: 'military_id', label: 'Military ID' },
  { value: 'other', label: 'Other' },
];

export function InOfficeSigningPanel({
  requestId,
  onChange,
}: {
  requestId: string;
  /** Called after a state-changing action so the host can refresh siblings. */
  onChange?: () => void;
}): JSX.Element | null {
  const canWrite = usePermission('proposal:write');
  const [data, setData] = useState<DetailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inOfficeOpen, setInOfficeOpen] = useState(false);
  const [idVerify, setIdVerify] = useState<Record<string, { idType: string; verified: boolean }>>(
    {},
  );
  const [qrSigner, setQrSigner] = useState<Signer | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    const d = await api<DetailResponse>(`/api/staff/signatures/${requestId}`);
    setData(d);
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    if (!qrSigner?.signingUrl) {
      setQrDataUrl(null);
      return;
    }
    void QRCode.toDataURL(qrSigner.signingUrl, { margin: 1, width: 224 }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [qrSigner]);

  if (!data) return null;
  const { request, signers, placements } = data;
  const isDraft = request.status === 'draft';
  const isLive = request.status === 'sent' || request.status === 'partially_signed';
  const showCard = isLive && request.signingMode === 'in_person';
  const requiresIdAttestation = request.formType === '8879';
  const inOfficeReady =
    !requiresIdAttestation ||
    signers.every((s) => {
      const v = idVerify[s.id];
      return Boolean(v?.idType) && v?.verified === true;
    });

  async function startInOffice(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: {
        inPerson: true;
        identityVerifications?: Array<{ signerId: string; idType: string }>;
      } = { inPerson: true };
      if (requiresIdAttestation) {
        body.identityVerifications = signers.map((s) => ({
          signerId: s.id,
          idType: idVerify[s.id]?.idType ?? '',
        }));
      }
      await api(`/api/staff/signatures/${requestId}/send`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setInOfficeOpen(false);
      await load();
      onChange?.();
    } catch (err) {
      setError(messageFor(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/signatures/${requestId}/refresh`, { method: 'POST' });
      await load();
      onChange?.();
    } catch (err) {
      setError(messageFor(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  // Draft: offer the in-office entry (or send the user to place fields first).
  if (isDraft) {
    if (!canWrite) return null;
    return (
      <div style={{ display: 'grid', gap: tokens.space.sm }}>
        {placements.length === 0 ? (
          <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
            Place signature fields before setting up in-office signing.{' '}
            <Link to={`/signatures/${requestId}`}>Open the request</Link> to place fields.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
              In-office signing has the signer(s) sign here in the office on a device — no email is
              sent to the client.
            </div>
            <div>
              <Button onClick={() => setInOfficeOpen(true)} disabled={busy}>
                Set up in-office signing
              </Button>
            </div>
          </>
        )}
        {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}
        {inOfficeOpen && (
          <SetupModal
            signers={signers}
            requiresIdAttestation={requiresIdAttestation}
            idVerify={idVerify}
            setIdVerify={setIdVerify}
            inOfficeReady={inOfficeReady}
            busy={busy}
            error={error}
            onCancel={() => setInOfficeOpen(false)}
            onStart={() => void startInOffice()}
          />
        )}
      </div>
    );
  }

  if (!showCard) return null;

  // Live in-person: the working card.
  return (
    <div style={{ display: 'grid', gap: tokens.space.sm }}>
      {canWrite && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="secondary"
            onClick={() => window.open(`/api/staff/signatures/${requestId}/qr-sheet.pdf`, '_blank')}
          >
            Print QR sheet
          </Button>
          <Button variant="ghost" onClick={() => void refreshStatus()} disabled={busy}>
            Refresh status
          </Button>
        </div>
      )}
      <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
        The signer(s) must be physically present. Hand each person their device or scan their QR.
      </div>
      {signers.map((s) => {
        const signed = s.status === 'signed';
        return (
          <div
            key={s.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              paddingBottom: 8,
              borderBottom: `1px solid ${tokens.color.border}`,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontWeight: 600, minWidth: 160 }}>{s.name}</span>
            <Pill tone={statusTone(s.status)}>{statusLabel(s.status)}</Pill>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <Button
                variant="secondary"
                onClick={() => window.open(s.signingUrl ?? '', '_blank')}
                disabled={!canWrite || !s.signingUrl || signed}
              >
                Sign now
              </Button>
              <Button variant="ghost" onClick={() => setQrSigner(s)} disabled={!s.signingUrl}>
                Show QR
              </Button>
            </div>
          </div>
        );
      })}
      {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}
      {qrSigner && (
        <div role="dialog" aria-modal="true" aria-label="Signer QR code" style={modalBackdrop}>
          <div style={{ ...modalPanel, width: 'min(320px, 95vw)' }}>
            <div style={modalHeader}>
              <div style={{ fontSize: 14, fontWeight: 600, color: tokens.color.text }}>
                {qrSigner.name}
              </div>
              <Button variant="ghost" onClick={() => setQrSigner(null)}>
                Close
              </Button>
            </div>
            <div
              style={{
                padding: tokens.space.md,
                display: 'grid',
                gap: tokens.space.sm,
                justifyItems: 'center',
              }}
            >
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={`QR code for ${qrSigner.name}`}
                  width={224}
                  height={224}
                />
              ) : (
                <div style={{ color: tokens.color.textMuted, fontSize: 13 }}>Generating…</div>
              )}
              <div style={{ fontSize: 12, color: tokens.color.textMuted, textAlign: 'center' }}>
                Scan with your phone camera to review and sign.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SetupModal({
  signers,
  requiresIdAttestation,
  idVerify,
  setIdVerify,
  inOfficeReady,
  busy,
  error,
  onCancel,
  onStart,
}: {
  signers: Signer[];
  requiresIdAttestation: boolean;
  idVerify: Record<string, { idType: string; verified: boolean }>;
  setIdVerify: React.Dispatch<
    React.SetStateAction<Record<string, { idType: string; verified: boolean }>>
  >;
  inOfficeReady: boolean;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onStart: () => void;
}): JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set up in-office signing"
      style={modalBackdrop}
    >
      <div style={{ ...modalPanel, width: 'min(560px, 95vw)' }}>
        <div style={modalHeader}>
          <div style={{ fontSize: 14, fontWeight: 600, color: tokens.color.text }}>
            Set up in-office signing
          </div>
          <Button variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
        <div style={{ padding: tokens.space.md, display: 'grid', gap: tokens.space.md }}>
          <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
            The signer(s) must be physically present. No email is sent.
          </div>
          {requiresIdAttestation && (
            <div style={{ display: 'grid', gap: tokens.space.sm }}>
              {signers.map((s) => {
                const v = idVerify[s.id] ?? { idType: '', verified: false };
                return (
                  <div
                    key={s.id}
                    style={{
                      display: 'grid',
                      gap: 6,
                      paddingBottom: 8,
                      borderBottom: `1px solid ${tokens.color.border}`,
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                    <Combobox
                      options={ID_TYPE_OPTIONS}
                      value={v.idType}
                      onChange={(idType) =>
                        setIdVerify((prev) => ({
                          ...prev,
                          [s.id]: { idType, verified: prev[s.id]?.verified ?? false },
                        }))
                      }
                      ariaLabel={`ID type for ${s.name}`}
                    />
                    <label
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        fontSize: 13,
                        color: tokens.color.text,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={v.verified}
                        onChange={(e) =>
                          setIdVerify((prev) => ({
                            ...prev,
                            [s.id]: {
                              idType: prev[s.id]?.idType ?? '',
                              verified: e.target.checked,
                            },
                          }))
                        }
                      />
                      I verified this person’s government photo ID in person.
                    </label>
                  </div>
                );
              })}
            </div>
          )}
          {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={onStart} disabled={busy || !inOfficeReady}>
              {busy ? 'Starting…' : 'Start in-office signing'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function messageFor(e: ApiError): string {
  const body = e.body as { error?: string } | undefined;
  if (body?.error === 'kba_required') {
    return 'Form 8879 (individual 1040) can’t be e-signed remotely — it requires Knowledge-Based Authentication, which this app doesn’t offer. Record the in-person photo-ID attestation above to sign in office.';
  }
  if (body?.error === 'identity_required') {
    return 'Record each signer’s in-person photo-ID verification before starting.';
  }
  return e.message || 'request_failed';
}

const modalBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: tokens.space.lg,
};

const modalPanel: React.CSSProperties = {
  background: tokens.color.surface,
  borderRadius: 8,
  boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
};

const modalHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.color.border}`,
};
