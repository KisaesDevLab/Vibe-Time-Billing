// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Signature request detail (P8). Shows the request, its signers, the field
// placements, and the event trail; lets staff upload the source PDF, apply
// a role-based profile, place fields (the editor — P9), send through
// OpenSign, or discard a draft. Mutations are draft-only server-side; the
// UI mirrors that (actions hidden once sent).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  Combobox,
  MailIcon,
  MessageIcon,
  Pill,
  Table,
  tokens,
  type TableColumn,
} from '@vibe/ui';

import { api, getCsrfToken, type ApiError } from '../api-client';
import { usePermission } from '../auth-context';
import { statusLabel, statusTone } from './Signatures';
import { FieldEditor } from './signatures/FieldEditor';
import { InOfficeSigningPanel } from './signatures/InOfficeSigningPanel';

interface Signer {
  id: string;
  name: string;
  email: string;
  phone: string | null;
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
  /** 0231 — how the signing links were (or will be) delivered. */
  notifyChannel: 'EMAIL' | 'SMS' | 'BOTH';
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
  // 0231 — how the signing links go out. Drafts are always EMAIL until the
  // firm picks otherwise here, so this needs no sync from the loaded row.
  const [notifyChannel, setNotifyChannel] = useState<'EMAIL' | 'SMS' | 'BOTH'>('EMAIL');
  // `${signerId}:${channel}` of the in-flight / last successful resend.
  const [resending, setResending] = useState<string | null>(null);
  const [resent, setResent] = useState<string | null>(null);
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

  async function saveAsProfile(): Promise<void> {
    const formType = window.prompt(
      'Save current placements as a profile for form type:',
      request?.formType ?? '',
    );
    if (!formType || !formType.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ formType: string; version: number; count: number }>(
        `/api/staff/signatures/${id}/save-profile`,
        { method: 'POST', body: JSON.stringify({ formType: formType.trim() }) },
      );
      setError(`Saved ${r.count} fields as profile ${r.formType} v${r.version}.`);
      await load();
    } catch (err) {
      const msg = (err as ApiError).message;
      setError(
        msg === 'signers_missing_roles'
          ? 'Every signer with a placed field needs a role before saving a profile (profiles are keyed by role).'
          : msg === 'no_placements'
            ? 'Place at least one field before saving a profile.'
            : messageFor(err as ApiError),
      );
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/signatures/${id}/send`, {
        method: 'POST',
        body: JSON.stringify({ notifyChannel }),
      });
      await load();
    } catch (err) {
      setError(messageFor(err as ApiError));
    } finally {
      setBusy(false);
    }
  }

  // Re-deliver one signer's existing link. Keyed by `${signerId}:${channel}`
  // so only the clicked icon shows its spinner state.
  async function resend(signerId: string, channel: 'EMAIL' | 'SMS'): Promise<void> {
    setResending(`${signerId}:${channel}`);
    setError(null);
    setResent(null);
    try {
      await api(`/api/staff/signatures/${id}/signers/${signerId}/resend`, {
        method: 'POST',
        body: JSON.stringify({ channel }),
      });
      setResent(`${signerId}:${channel}`);
      await load();
    } catch (err) {
      const msg = (err as ApiError).message;
      setError(
        msg === 'no_phone'
          ? 'That signer has no mobile number on file.'
          : msg === 'already_signed'
            ? 'That signer has already signed.'
            : msg === 'sms_not_configured'
              ? 'Text messaging isn’t configured on this server.'
              : msg === 'email_not_configured'
                ? 'Email isn’t configured on this server.'
                : msg === 'no_signing_link'
                  ? 'No signing link exists yet for that signer.'
                  : messageFor(err as ApiError),
      );
    } finally {
      setResending(null);
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
  // Live requests keep the card whatever channel they went out on — the QR
  // sheet is the "they showed up in person after all" path, and printing it
  // neither re-sends nor invalidates the link the client already has.
  const showInOfficeCard = (isDraft && canWrite) || isLive;
  const requiresIdAttestation = request.formType === '8879';

  const signerCols: TableColumn<Signer>[] = [
    { key: 'name', header: 'Name', render: (s) => s.name },
    { key: 'email', header: 'Email', render: (s) => s.email },
    { key: 'phone', header: 'Mobile', render: (s) => s.phone ?? '—' },
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
    // Resend the signer's existing link. Only meaningful while the request
    // is live and that signer still owes a signature.
    {
      key: 'resend',
      header: 'Resend',
      align: 'center',
      render: (s) => {
        if (!isLive || !canWrite || s.status === 'signed') return '—';
        return (
          <span style={{ display: 'inline-flex', gap: 2 }}>
            <ResendButton
              label={`Resend to ${s.name} by email`}
              icon={<MailIcon size={16} />}
              busy={resending === `${s.id}:EMAIL`}
              done={resent === `${s.id}:EMAIL`}
              onClick={() => void resend(s.id, 'EMAIL')}
            />
            <ResendButton
              label={
                s.phone ? `Resend to ${s.name} by text` : `${s.name} has no mobile number on file`
              }
              icon={<MessageIcon size={16} />}
              busy={resending === `${s.id}:SMS`}
              done={resent === `${s.id}:SMS`}
              disabled={!s.phone}
              onClick={() => void resend(s.id, 'SMS')}
            />
          </span>
        );
      },
    },
  ];

  // 0231 — a text needs a number; surface who can't be reached before send.
  const textingChosen = notifyChannel !== 'EMAIL';
  const signersWithoutPhone = signers.filter((s) => !s.phone?.trim()).map((s) => s.name);
  const noTextableSigner = notifyChannel === 'SMS' && signersWithoutPhone.length === signers.length;

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
          title={
            isLive && request.signingMode !== 'in_person'
              ? 'Sign in office instead (QR)'
              : 'In-office signing'
          }
        >
          <InOfficeSigningPanel requestId={id} onChange={() => void load()} />
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
                  <Button
                    variant="ghost"
                    title="Save this request's current field placements as a new reusable profile version (keyed by signer role)"
                    onClick={() => void saveAsProfile()}
                    disabled={busy || placements.length === 0}
                  >
                    Save as profile
                  </Button>
                </div>

                <FieldEditor
                  requestId={id}
                  signers={signers}
                  placements={placements}
                  onSaved={() => void load()}
                />

                {requiresIdAttestation && (
                  <div
                    style={{
                      fontSize: 13,
                      color: tokens.color.textMuted,
                      background: tokens.color.bg,
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: 6,
                      padding: tokens.space.sm,
                    }}
                  >
                    Form 8879 for an individual <strong>1040</strong> can’t be e-signed remotely —
                    the IRS requires Knowledge-Based Authentication, which this app doesn’t offer.
                    Have the taxpayer sign <strong>in office</strong>: no email goes to the client,
                    and recording in-person photo-ID verification satisfies the IRS in-person
                    requirement (Pub 1345).
                  </div>
                )}
                {textingChosen && signersWithoutPhone.length > 0 && (
                  <div
                    style={{
                      fontSize: 13,
                      color: noTextableSigner ? tokens.color.danger : tokens.color.textMuted,
                      marginTop: tokens.space.sm,
                    }}
                  >
                    {noTextableSigner
                      ? 'No signer has a mobile number — add one before sending by text.'
                      : `No mobile on file for ${signersWithoutPhone.join(', ')}; ` +
                        (notifyChannel === 'BOTH'
                          ? 'they will only get the email.'
                          : 'they will not be notified.')}
                  </div>
                )}
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    marginTop: tokens.space.md,
                  }}
                >
                  <Button variant="danger" onClick={() => void discard()} disabled={busy}>
                    Discard draft
                  </Button>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {requiresIdAttestation ? (
                      <span
                        style={{ fontSize: 13, color: tokens.color.textMuted, alignSelf: 'center' }}
                      >
                        Use the <strong>In-office signing</strong> card above to sign this 1040.
                      </span>
                    ) : (
                      <>
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 13,
                            color: tokens.color.textMuted,
                          }}
                        >
                          Deliver by
                          <select
                            aria-label="Deliver the signing link by"
                            value={notifyChannel}
                            onChange={(e) =>
                              setNotifyChannel(e.target.value as 'EMAIL' | 'SMS' | 'BOTH')
                            }
                            style={{
                              padding: '6px 8px',
                              background: tokens.color.surface,
                              color: tokens.color.text,
                              border: `1px solid ${tokens.color.border}`,
                              borderRadius: tokens.radius.sm,
                              fontSize: 13,
                            }}
                          >
                            <option value="EMAIL">Email</option>
                            <option value="SMS">Text</option>
                            <option value="BOTH">Email + text</option>
                          </select>
                        </label>
                        <Button
                          onClick={() => void send()}
                          disabled={busy || placements.length === 0 || noTextableSigner}
                        >
                          {busy ? 'Sending…' : 'Send for signature'}
                        </Button>
                      </>
                    )}
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
    </div>
  );
}

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
    return 'Form 8879 (individual 1040) can’t be e-signed remotely — it requires Knowledge-Based Authentication, which this app doesn’t offer. Use “Set up in-office signing” instead.';
  }
  if (body?.error === 'no_source') return 'Upload a source PDF before sending.';
  return e.message || 'request_failed';
}

/** Icon-only resend action. Shows a check briefly after a successful send so
 *  the click has visible feedback without a toast system. */
function ResendButton({
  label,
  icon,
  busy,
  done,
  disabled,
  onClick,
}: {
  label: string;
  icon: JSX.Element;
  busy: boolean;
  done: boolean;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled || busy}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        background: 'transparent',
        border: 'none',
        borderRadius: tokens.radius.sm,
        color: done ? tokens.color.success : tokens.color.textMuted,
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? 'not-allowed' : busy ? 'progress' : 'pointer',
      }}
    >
      {done ? '✓' : icon}
    </button>
  );
}
