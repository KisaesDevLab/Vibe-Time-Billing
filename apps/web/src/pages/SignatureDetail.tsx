// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Signature request detail (P8). Shows the request, its signers, the field
// placements, and the event trail; lets staff upload the source PDF, apply
// a role-based profile, place fields (the editor — P9), send through
// OpenSign, or discard a draft. Mutations are draft-only server-side; the
// UI mirrors that (actions hidden once sent).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { Button, Card, Combobox, Pill, Table, tokens, type TableColumn } from '@vibe/ui';

import { api, getCsrfToken, type ApiError } from '../api-client';
import { usePermission } from '../auth-context';
import { statusLabel, statusTone } from './Signatures';
import { FieldEditor } from './signatures/FieldEditor';

interface Signer {
  id: string;
  name: string;
  email: string;
  role: string | null;
  order: number;
  status: string;
  signedAt: string | null;
  signingUrl?: string | null;
}
interface Placement {
  id: string;
  signerId: string;
  fieldType: string;
  pageNumber: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  required: boolean;
}
interface SigEvent {
  id: string;
  actor: string;
  event: string;
  detail: unknown;
  createdAt: string;
}
interface PageGeometry {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
}
interface RequestDetail {
  id: string;
  title: string;
  status: string;
  signingMode: string;
  formType: string | null;
  sourceFileKey: string | null;
  pageGeometry: PageGeometry[] | null;
  signerCount: number;
  signedCount: number;
  sentAt: string | null;
  expiresAt: string | null;
  certificateFileUrl: string | null;
}
interface NamedRef {
  id: string;
  name: string;
}
interface DetailResponse {
  request: RequestDetail;
  signers: Signer[];
  placements: Placement[];
  events: SigEvent[];
  client: NamedRef | null;
  engagement: NamedRef | null;
}
interface Profile {
  id: string;
  formType: string;
  version: number;
}

// Raw PDF upload — bypasses the JSON api() wrapper (the source endpoint
// reads an application/pdf body).
async function uploadSource(id: string, file: File): Promise<{ pages: number }> {
  const csrf = getCsrfToken();
  const res = await fetch(`/api/staff/signatures/${id}/source`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: file,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `upload_failed_${res.status}`);
  }
  return (await res.json()) as { pages: number };
}

export function SignatureDetailPage(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const canWrite = usePermission('proposal:write');
  const [data, setData] = useState<DetailResponse | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [inOfficeOpen, setInOfficeOpen] = useState(false);
  // Per-signer identity attestation for the 8879 in-office path:
  // signerId -> { idType, verified }.
  const [idVerify, setIdVerify] = useState<Record<string, { idType: string; verified: boolean }>>(
    {},
  );
  const [qrSigner, setQrSigner] = useState<Signer | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, p] = await Promise.all([
        api<DetailResponse>(`/api/staff/signatures/${id}`),
        api<{ profiles: Profile[] }>('/api/staff/signatures/profiles').catch(() => ({
          profiles: [],
        })),
      ]);
      setData(d);
      setProfiles(p.profiles ?? []);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Render the selected signer's QR when the Show-QR modal opens.
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

  if (loading || !data) {
    return (
      <div style={{ color: tokens.color.textMuted, fontSize: 13, padding: tokens.space.lg }}>
        Loading…
      </div>
    );
  }

  const { request, signers, placements, events, client, engagement } = data;
  const isDraft = request.status === 'draft';
  const hasSource = Boolean(request.sourceFileKey);

  async function onUpload(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await uploadSource(id, file);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'upload_failed');
    } finally {
      setBusy(false);
    }
  }

  async function applyProfile(): Promise<void> {
    if (!profileId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ count: number; unmatchedRoles: string[] }>(
        `/api/staff/signatures/${id}/apply-profile`,
        { method: 'POST', body: JSON.stringify({ profileId }) },
      );
      if (r.unmatchedRoles?.length) {
        setError(
          `Profile applied (${r.count} fields). Unmatched roles: ${r.unmatchedRoles.join(', ')}`,
        );
      }
      await load();
    } catch (err) {
      const e = err as ApiError;
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/signatures/${id}/send`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(messageFor(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  async function startInOffice(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body: {
        inPerson: true;
        identityVerifications?: Array<{ signerId: string; idType: string }>;
      } = {
        inPerson: true,
      };
      if (request.formType === '8879') {
        body.identityVerifications = signers.map((s) => ({
          signerId: s.id,
          idType: idVerify[s.id]?.idType ?? '',
        }));
      }
      await api(`/api/staff/signatures/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setInOfficeOpen(false);
      await load();
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
      await api(`/api/staff/signatures/${id}/refresh`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(messageFor(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    if (!window.confirm('Discard this draft? This cannot be undone.')) return;
    setBusy(true);
    try {
      await api(`/api/staff/signatures/${id}`, { method: 'DELETE' });
      navigate('/signatures');
    } catch (err) {
      setError(messageFor(err as ApiError));
      setBusy(false);
    }
  }

  async function voidRequest(): Promise<void> {
    if (!window.confirm('Void this request? Signers can no longer complete it.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/signatures/${id}/void`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(messageFor(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  const isTerminal = ['completed', 'declined', 'expired', 'voided'].includes(request.status);
  const canVoid = !isTerminal && request.status !== 'draft';

  const isLive = request.status === 'sent' || request.status === 'partially_signed';
  const showInOfficeCard = isLive && request.signingMode === 'in_person';
  const requiresIdAttestation = request.formType === '8879';
  const inOfficeReady =
    !requiresIdAttestation ||
    signers.every((s) => {
      const v = idVerify[s.id];
      return Boolean(v?.idType) && v?.verified === true;
    });
  const idTypeOptions = [
    { value: '', label: 'Select ID type…' },
    { value: 'drivers_license', label: 'Driver’s license' },
    { value: 'state_id', label: 'State ID' },
    { value: 'passport', label: 'Passport' },
    { value: 'military_id', label: 'Military ID' },
    { value: 'other', label: 'Other' },
  ];

  const signerCols: TableColumn<Signer>[] = [
    { key: 'name', header: 'Name', render: (s) => s.name },
    { key: 'email', header: 'Email', render: (s) => s.email },
    { key: 'role', header: 'Role', render: (s) => s.role ?? '—' },
    {
      key: 'fields',
      header: 'Fields',
      align: 'center',
      render: (s) => placements.filter((p) => p.signerId === s.id).length,
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => <Pill tone={statusTone(s.status)}>{statusLabel(s.status)}</Pill>,
    },
  ];

  const profileOptions = [
    { value: '', label: 'Choose a profile…' },
    ...profiles.map((p) => ({ value: p.id, label: `${p.formType} v${p.version}` })),
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card
        title={request.title}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Pill tone={statusTone(request.status)}>{statusLabel(request.status)}</Pill>
            {request.status === 'completed' && (
              <Button variant="secondary" onClick={() => setPreviewOpen(true)}>
                Preview signed
              </Button>
            )}
            {request.status === 'completed' && (
              <Button
                variant="secondary"
                title="Signed document with the audit certificate appended"
                onClick={() => window.open(`/api/staff/signatures/${id}/signed`, '_blank')}
              >
                Download signed PDF
              </Button>
            )}
            {/* Legacy: requests completed before the certificate was merged
                into the signed PDF stored it as a separate file. */}
            {request.status === 'completed' && request.certificateFileUrl && (
              <Button
                variant="secondary"
                onClick={() => window.open(`/api/staff/signatures/${id}/certificate`, '_blank')}
              >
                Download certificate
              </Button>
            )}
            {canVoid && canWrite && (
              <Button variant="danger" onClick={() => void voidRequest()} disabled={busy}>
                Void
              </Button>
            )}
            <Button variant="ghost" onClick={() => navigate('/signatures')}>
              ← Back
            </Button>
          </div>
        }
      >
        <div style={{ display: 'flex', gap: tokens.space.xl, fontSize: 13, flexWrap: 'wrap' }}>
          {client && <Meta label="Client" value={client.name} />}
          {engagement && <Meta label="Engagement" value={engagement.name} />}
          <Meta label="Form" value={request.formType ?? 'Generic'} />
          <Meta label="Signed" value={`${request.signedCount}/${request.signerCount}`} />
          <Meta label="Pages" value={String(request.pageGeometry?.length ?? 0)} />
          <Meta label="Fields" value={String(placements.length)} />
          {request.sentAt && (
            <Meta label="Sent" value={new Date(request.sentAt).toLocaleString()} />
          )}
          {request.expiresAt && (
            <Meta label="Expires" value={new Date(request.expiresAt).toLocaleDateString()} />
          )}
        </div>
        {error && (
          <div style={{ color: tokens.color.danger, fontSize: 13, marginTop: tokens.space.md }}>
            {error}
          </div>
        )}
      </Card>

      <Card title="Signers">
        <Table columns={signerCols} rows={signers} rowKey={(s) => s.id} empty="No signers." />
      </Card>

      {showInOfficeCard && (
        <Card
          title="In-office signing"
          action={
            canWrite ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  variant="secondary"
                  onClick={() => window.open(`/api/staff/signatures/${id}/qr-sheet.pdf`, '_blank')}
                >
                  Print QR sheet
                </Button>
                <Button variant="ghost" onClick={() => void refreshStatus()} disabled={busy}>
                  Refresh status
                </Button>
              </div>
            ) : undefined
          }
        >
          <div style={{ display: 'grid', gap: tokens.space.sm }}>
            <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
              The signer(s) must be physically present. Hand each person their device or scan their
              QR.
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
          </div>
        </Card>
      )}

      {isDraft && canWrite && (
        <Card title="Prepare & send">
          <div style={{ display: 'grid', gap: tokens.space.md }}>
            {!hasSource ? (
              <div>
                <div style={{ fontSize: 13, color: tokens.color.textMuted, marginBottom: 8 }}>
                  Upload the source PDF to place signature fields.
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onUpload(f);
                  }}
                />
                <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                  {busy ? 'Uploading…' : 'Upload PDF'}
                </Button>
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-end',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 240 }}>
                    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                      Apply a placement profile (by role)
                    </div>
                    <Combobox
                      options={profileOptions}
                      value={profileId}
                      onChange={setProfileId}
                      ariaLabel="Placement profile"
                    />
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => void applyProfile()}
                    disabled={busy || !profileId}
                  >
                    Apply profile
                  </Button>
                </div>

                <FieldEditor
                  requestId={id}
                  signers={signers}
                  placements={placements}
                  onSaved={() => void load()}
                />

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginTop: tokens.space.md,
                  }}
                >
                  <Button variant="danger" onClick={() => void discard()} disabled={busy}>
                    Discard draft
                  </Button>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button
                      variant="secondary"
                      onClick={() => setInOfficeOpen(true)}
                      disabled={busy || placements.length === 0}
                    >
                      Set up in-office signing
                    </Button>
                    <Button onClick={() => void send()} disabled={busy || placements.length === 0}>
                      {busy ? 'Sending…' : 'Send for signature'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>
      )}

      <Card title="Activity">
        <div style={{ display: 'grid', gap: 6 }}>
          {events.length === 0 && (
            <div style={{ color: tokens.color.textMuted, fontSize: 13 }}>No activity yet.</div>
          )}
          {events.map((e) => (
            <div
              key={e.id}
              style={{
                display: 'flex',
                gap: 12,
                fontSize: 13,
                paddingBottom: 6,
                borderBottom: `1px solid ${tokens.color.border}`,
              }}
            >
              <span style={{ color: tokens.color.textMuted, minWidth: 150 }}>
                {new Date(e.createdAt).toLocaleString()}
              </span>
              <span style={{ fontWeight: 600 }}>{e.event}</span>
              <span style={{ color: tokens.color.textMuted }}>{e.actor}</span>
            </div>
          ))}
        </div>
      </Card>

      {previewOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Signed document preview"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: tokens.space.lg,
          }}
        >
          <div
            style={{
              background: tokens.color.surface,
              borderRadius: 8,
              width: 'min(960px, 95vw)',
              height: '90vh',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: `${tokens.space.sm}px ${tokens.space.md}px`,
                borderBottom: `1px solid ${tokens.color.border}`,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, color: tokens.color.text }}>
                {request.title} — signed
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  variant="secondary"
                  onClick={() => window.open(`/api/staff/signatures/${id}/signed`, '_blank')}
                >
                  Open in new tab
                </Button>
                <Button variant="ghost" onClick={() => setPreviewOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
            <iframe
              title="Signed document"
              src={`/api/staff/signatures/${id}/signed?inline=1`}
              style={{ flex: 1, border: 'none', width: '100%' }}
            />
          </div>
        </div>
      )}

      {inOfficeOpen && (
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
              <Button variant="ghost" onClick={() => setInOfficeOpen(false)}>
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
                          options={idTypeOptions}
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
                <Button variant="ghost" onClick={() => setInOfficeOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void startInOffice()} disabled={busy || !inOfficeReady}>
                  {busy ? 'Starting…' : 'Start in-office signing'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

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
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
};

const modalHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.color.border}`,
};

function Meta({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ color: tokens.color.text }}>{value}</div>
    </div>
  );
}

function messageFor(e: ApiError): string {
  const body = e.body as
    | { error?: string; errors?: Array<{ path: string; message: string }> }
    | undefined;
  if (body?.error === 'invalid_placements' && body.errors?.length) {
    return `Cannot send: ${body.errors.map((x) => `${x.path} ${x.message}`).join('; ')}`;
  }
  if (body?.error === 'kba_required') {
    return 'This form (1040 8879) requires Knowledge-Based Authentication and cannot be sent via the entity path.';
  }
  if (body?.error === 'no_source') return 'Upload a source PDF before sending.';
  return e.message || 'request_failed';
}
