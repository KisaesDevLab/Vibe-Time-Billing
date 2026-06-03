/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal access card — lists who can sign in to the client portal on
// behalf of this client, plus exposes the staff "View as client"
// shortcut for each active access row.
//
// Capabilities per row (when expanded):
//   - Edit name / email / phone  → PATCH /portal-invites/access/:id/identity
//   - Change role                → PATCH /portal-invites/access/:id
//   - Revoke (status → INACTIVE) → POST  /portal-invites/access/:id/revoke
//   - Restore (INACTIVE → ACTIVE)→ POST  /portal-invites/access/:id/restore
//   - View as client (ACTIVE)    → POST  /clients/:clientId/impersonate
//
// Pending invitations get a Resend button (POST /portal-invites/:id/resend).
//
// Empty state walks the user through inviting the first contact rather
// than silently leaving the card blank.

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type Role = 'FULL' | 'VIEW_ONLY' | 'PAY_ONLY';
type AccessStatus = 'INVITED' | 'ACTIVE' | 'INACTIVE';

interface Access {
  id: string;
  portalIdentityId: string;
  role: Role;
  status: AccessStatus;
  invitedAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  fullName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  primaryEmailVerifiedAt: string | null;
  primaryPhoneVerifiedAt: string | null;
  identityStatus: 'ACTIVE' | 'DISABLED';
  lastLoginAt: string | null;
}

interface PendingInvitation {
  id: string;
  proposedFullName: string;
  invitedEmail: string | null;
  invitedPhone: string | null;
  proposedRole: Role;
  deliveryChannel: 'EMAIL' | 'SMS';
  expiresAt: string;
}

interface AccessListResponse {
  accesses: Access[];
  pendingInvitations: PendingInvitation[];
}

interface IssueResponse {
  portalUrl: string;
}

interface InviteResponse {
  ok: true;
  deduped?: boolean;
  identityId?: string;
  invitationId?: string;
}

const ROLE_OPTIONS = [
  { value: 'FULL', label: 'Full access' },
  { value: 'VIEW_ONLY', label: 'View only' },
  { value: 'PAY_ONLY', label: 'Pay only' },
];

const CHANNEL_OPTIONS = [
  { value: 'EMAIL', label: 'Email' },
  { value: 'SMS', label: 'Text message' },
];

const ROLE_LABEL: Record<Role, string> = {
  FULL: 'Full access',
  VIEW_ONLY: 'View only',
  PAY_ONLY: 'Pay only',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function PortalAccessCard({ clientId }: { clientId: string }): JSX.Element {
  const [accesses, setAccesses] = useState<Access[] | null>(null);
  const [pending, setPending] = useState<PendingInvitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<AccessListResponse>(`/api/staff/portal-invites/by-client/${clientId}`);
      setAccesses(r.accesses);
      setPending(r.pendingInvitations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
      setAccesses([]);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function resend(invitationId: string, label: string): Promise<void> {
    setResendingId(invitationId);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/staff/portal-invites/${invitationId}/resend`, {
        method: 'POST',
        body: '{}',
      });
      setNotice(`Invitation re-sent to ${label}. The previous link is now invalid.`);
      void load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'resend_failed';
      if (msg === 'invitation_not_active') {
        setError('That invitation is no longer active (already accepted, revoked, or expired).');
      } else {
        setError(`Could not resend: ${msg}`);
      }
    } finally {
      setResendingId(null);
    }
  }

  async function viewAs(accessId: string): Promise<void> {
    setBusyId(accessId);
    setError(null);
    setNotice(null);
    try {
      const r = await api<IssueResponse>(`/api/staff/clients/${clientId}/impersonate`, {
        method: 'POST',
        body: JSON.stringify({ accessId }),
      });
      window.open(r.portalUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'failed';
      if (msg === 'forbidden' || msg === 'permission_denied') {
        setError('You don’t have permission to view as this client.');
      } else {
        setError(`Could not start view-as session: ${msg}`);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(accessId: string, name: string): Promise<void> {
    if (
      !window.confirm(
        `Revoke portal access for ${name}? They will be signed out and can no longer sign in until restored.`,
      )
    )
      return;
    setBusyId(accessId);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/staff/portal-invites/access/${accessId}/revoke`, {
        method: 'POST',
        body: '{}',
      });
      setNotice(`Access revoked for ${name}.`);
      void load();
    } catch (err) {
      setError(`Revoke failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setBusyId(null);
    }
  }

  async function restore(accessId: string, name: string): Promise<void> {
    setBusyId(accessId);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/staff/portal-invites/access/${accessId}/restore`, {
        method: 'POST',
        body: '{}',
      });
      setNotice(`Access restored for ${name}.`);
      void load();
    } catch (err) {
      setError(`Restore failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setBusyId(null);
    }
  }

  const hasAny = (accesses?.length ?? 0) + pending.length > 0;

  return (
    <Card
      title="Portal access"
      action={
        <Button
          size="sm"
          variant={showInvite ? 'ghost' : 'secondary'}
          onClick={() => setShowInvite((v) => !v)}
        >
          {showInvite ? 'Cancel' : '+ Invite to portal'}
        </Button>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{notice}</p>
      )}

      {showInvite && (
        <InviteForm
          clientId={clientId}
          onCreated={() => {
            setShowInvite(false);
            void load();
          }}
          onError={setError}
        />
      )}

      {accesses == null ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : !hasAny ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          Nobody can sign in to this client&apos;s portal yet. Click{' '}
          <strong>+ Invite to portal</strong> above to send an email or text invitation. Once they
          accept, you&apos;ll be able to <strong>View as client</strong> to see exactly what they
          see.
        </p>
      ) : (
        <>
          {accesses && accesses.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
              {accesses.map((a) => (
                <AccessRow
                  key={a.id}
                  access={a}
                  expanded={expandedId === a.id}
                  busy={busyId === a.id}
                  onToggle={() => setExpandedId((cur) => (cur === a.id ? null : a.id))}
                  onViewAs={() => void viewAs(a.id)}
                  onRevoke={() => void revoke(a.id, a.fullName)}
                  onRestore={() => void restore(a.id, a.fullName)}
                  onSaved={() => {
                    setExpandedId(null);
                    setNotice(`Updated ${a.fullName}.`);
                    void load();
                  }}
                  onError={setError}
                />
              ))}
            </ul>
          )}
          {pending.length > 0 && (
            <>
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  margin: '12px 0 6px',
                }}
              >
                Pending invitations
              </div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                {pending.map((p) => {
                  const contact = p.invitedEmail ?? p.invitedPhone ?? '—';
                  return (
                    <li
                      key={p.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        fontSize: 13,
                        background: tokens.color.surface,
                        border: `1px solid ${tokens.color.border}`,
                        borderRadius: tokens.radius.sm,
                      }}
                    >
                      <span style={{ fontWeight: 500 }}>{p.proposedFullName}</span>
                      <span style={{ color: tokens.color.textMuted }}>{contact}</span>
                      <Pill>{ROLE_LABEL[p.proposedRole]}</Pill>
                      <Pill tone="warning">Awaiting acceptance</Pill>
                      <span
                        style={{
                          marginLeft: 'auto',
                          fontSize: 11,
                          color: tokens.color.textMuted,
                        }}
                      >
                        Expires {p.expiresAt.slice(0, 10)}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={resendingId === p.id}
                        onClick={() => void resend(p.id, contact)}
                        title="Send a new invitation link. The previous link is invalidated."
                      >
                        {resendingId === p.id ? 'Resending…' : 'Resend'}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}

interface AccessRowProps {
  access: Access;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onViewAs: () => void;
  onRevoke: () => void;
  onRestore: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}

function AccessRow({
  access: a,
  expanded,
  busy,
  onToggle,
  onViewAs,
  onRevoke,
  onRestore,
  onSaved,
  onError,
}: AccessRowProps): JSX.Element {
  const isInactive = a.status === 'INACTIVE';
  const contactSummary = a.primaryEmail ?? a.primaryPhone ?? '—';
  return (
    <li
      style={{
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 10px',
          width: '100%',
          boxSizing: 'border-box',
        }}
        aria-expanded={expanded}
        aria-label={`Expand portal-access details for ${a.fullName}`}
      >
        <span style={{ fontSize: 12, color: tokens.color.textMuted, width: 10 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <div style={{ display: 'grid', gap: 2, flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span
              style={{
                fontWeight: 600,
                color: isInactive ? tokens.color.textMuted : tokens.color.text,
              }}
            >
              {a.fullName}
            </span>
            <Pill>{ROLE_LABEL[a.role]}</Pill>
            <Pill
              tone={
                a.status === 'ACTIVE' ? 'success' : a.status === 'INVITED' ? 'warning' : 'neutral'
              }
            >
              {a.status}
            </Pill>
            {a.lastLoginAt && (
              <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                last signed in {fmtDate(a.lastLoginAt)}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: tokens.color.textMuted }}>{contactSummary}</div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={a.status !== 'ACTIVE' || busy}
          onClick={(e) => {
            e.stopPropagation();
            onViewAs();
          }}
          title={
            a.status === 'ACTIVE'
              ? 'Open the client portal in a new tab as this person (read-only).'
              : 'View-as is only available for ACTIVE accesses.'
          }
        >
          {busy ? 'Opening…' : 'View as client ↗'}
        </Button>
      </button>

      {expanded && (
        <div
          style={{
            borderTop: `1px solid ${tokens.color.border}`,
            padding: '12px',
            display: 'grid',
            gap: 12,
          }}
        >
          <DetailGrid access={a} />
          <EditIdentityForm access={a} onSaved={onSaved} onError={onError} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isInactive ? (
              <Button size="sm" variant="primary" disabled={busy} onClick={onRestore}>
                Restore access
              </Button>
            ) : (
              <Button size="sm" variant="danger" disabled={busy} onClick={onRevoke}>
                Revoke access
              </Button>
            )}
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
              {isInactive
                ? 'Currently revoked — they cannot sign in.'
                : 'Revoking signs them out and blocks future sign-ins. Reversible via Restore.'}
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

function DetailGrid({ access: a }: { access: Access }): JSX.Element {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '4px 12px',
        fontSize: 12,
        margin: 0,
      }}
    >
      <dt style={{ color: tokens.color.textMuted }}>Portal identity ID</dt>
      <dd style={{ margin: 0, fontFamily: tokens.font.mono }}>{a.portalIdentityId}</dd>
      <dt style={{ color: tokens.color.textMuted }}>Email verified</dt>
      <dd style={{ margin: 0 }}>
        {a.primaryEmailVerifiedAt ? fmtDate(a.primaryEmailVerifiedAt) : '—'}
      </dd>
      <dt style={{ color: tokens.color.textMuted }}>Phone verified</dt>
      <dd style={{ margin: 0 }}>
        {a.primaryPhoneVerifiedAt ? fmtDate(a.primaryPhoneVerifiedAt) : '—'}
      </dd>
      <dt style={{ color: tokens.color.textMuted }}>Invited</dt>
      <dd style={{ margin: 0 }}>{fmtDate(a.invitedAt)}</dd>
      <dt style={{ color: tokens.color.textMuted }}>Accepted</dt>
      <dd style={{ margin: 0 }}>{fmtDate(a.acceptedAt)}</dd>
      {a.revokedAt && (
        <>
          <dt style={{ color: tokens.color.textMuted }}>Revoked</dt>
          <dd style={{ margin: 0 }}>{fmtDate(a.revokedAt)}</dd>
        </>
      )}
      <dt style={{ color: tokens.color.textMuted }}>Identity status</dt>
      <dd style={{ margin: 0 }}>{a.identityStatus}</dd>
    </dl>
  );
}

interface EditFormProps {
  access: Access;
  onSaved: () => void;
  onError: (msg: string) => void;
}

function EditIdentityForm({ access: a, onSaved, onError }: EditFormProps): JSX.Element {
  const [fullName, setFullName] = useState(a.fullName);
  const [email, setEmail] = useState(a.primaryEmail ?? '');
  const [phone, setPhone] = useState(a.primaryPhone ?? '');
  const [role, setRole] = useState<Role>(a.role);
  const [saving, setSaving] = useState(false);

  const dirty =
    fullName !== a.fullName ||
    email !== (a.primaryEmail ?? '') ||
    phone !== (a.primaryPhone ?? '') ||
    role !== a.role;

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    onError('');
    try {
      const identityChanged =
        fullName !== a.fullName ||
        email !== (a.primaryEmail ?? '') ||
        phone !== (a.primaryPhone ?? '');
      if (identityChanged) {
        await api(`/api/staff/portal-invites/access/${a.id}/identity`, {
          method: 'PATCH',
          body: JSON.stringify({ fullName, email, phone }),
        });
      }
      if (role !== a.role) {
        await api(`/api/staff/portal-invites/access/${a.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        });
      }
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'save_failed';
      const friendly =
        msg === 'contact_in_use'
          ? 'That email or phone is already in use by another portal identity at your firm.'
          : msg === 'invalid_phone'
            ? 'Phone must be a valid number. Use E.164 format (e.g. +15555550123).'
            : msg;
      onError(`Save failed: ${friendly}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Input label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        <div>
          <label
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Role
          </label>
          <Combobox
            ariaLabel="Role"
            value={role}
            onChange={(v) => setRole(v as Role)}
            options={ROLE_OPTIONS}
          />
        </div>
        <Input
          type="email"
          label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="(none)"
        />
        <Input
          label="Phone (E.164)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(none)"
        />
      </div>
      <div>
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

interface InviteFormProps {
  clientId: string;
  onCreated: () => void;
  onError: (msg: string) => void;
}

function InviteForm({ clientId, onCreated, onError }: InviteFormProps): JSX.Element {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('FULL');
  const [channel, setChannel] = useState<'EMAIL' | 'SMS'>('EMAIL');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    onError('');
    setResult(null);
    try {
      const body: Record<string, unknown> = {
        clientId,
        fullName: fullName.trim(),
        role,
        deliveryChannel: channel,
      };
      if (email.trim()) body['email'] = email.trim();
      if (phone.trim()) body['phone'] = phone.trim();
      const r = await api<InviteResponse>('/api/staff/portal-invites', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (r.deduped) {
        setResult(
          'That contact already has a portal identity at this firm — access added immediately.',
        );
      } else {
        setResult(
          channel === 'EMAIL'
            ? `Invitation email queued to ${email.trim()}.`
            : `Invitation text queued to ${phone.trim()}.`,
        );
      }
      setTimeout(() => {
        setFullName('');
        setEmail('');
        setPhone('');
        onCreated();
      }, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invite_failed';
      const friendly =
        msg === 'invalid_payload'
          ? 'Check the form — name plus either email or phone is required.'
          : msg;
      onError(`Invitation failed: ${friendly}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: 'grid',
        gap: 10,
        padding: 12,
        marginBottom: 14,
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
      }}
    >
      <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
        Invites a person to the <strong>client portal</strong> for this client — they sign in with a
        magic link or password and see the invoices, files, and requests for this client only. You
        can then use the <strong>View as client</strong> button to preview exactly what they see
        (read-only, 60-minute session).
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Input
          label="Full name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          placeholder="Jane Doe"
        />
        <div>
          <label
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Role
          </label>
          <Combobox
            ariaLabel="Role"
            value={role}
            onChange={(v) => setRole(v as Role)}
            options={ROLE_OPTIONS}
          />
        </div>
        <Input
          type="email"
          label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@example.com"
        />
        <Input
          label="Phone (E.164)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+15555550123"
        />
        <div>
          <label
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              display: 'block',
              marginBottom: 4,
            }}
          >
            Send invitation via
          </label>
          <Combobox
            ariaLabel="Delivery channel"
            value={channel}
            onChange={(v) => setChannel(v as 'EMAIL' | 'SMS')}
            options={CHANNEL_OPTIONS}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          type="submit"
          size="sm"
          disabled={submitting || !fullName.trim() || (!email.trim() && !phone.trim())}
        >
          {submitting ? 'Sending…' : 'Send invitation'}
        </Button>
        {result && <span style={{ fontSize: 12, color: tokens.color.success }}>{result}</span>}
      </div>
    </form>
  );
}
