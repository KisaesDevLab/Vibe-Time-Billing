/* eslint-disable jsx-a11y/label-has-associated-control -- labels sit beside their Combobox controls inside grid cells; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Unified "People" card (0114) — replaces the separate Contacts and
// Portal Access cards. Each person appears once with their directory role
// AND their portal status, reconciled via the client_contact_id link:
//   - a contact who also logs in → one row with both
//   - a directory contact with no login → "No portal access" + Invite
//   - a 3rd party who logs in but isn't a contact → "Portal only" + Add to contacts
//   - a pending invitation → "Awaiting acceptance" + Resend
//
// Backed by GET /api/staff/clients/:id/people; actions reuse the existing
// contact + portal-invite endpoints.

import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';

type Role = 'FULL' | 'VIEW_ONLY' | 'PAY_ONLY';
type Kind = 'linked' | 'contact_only' | 'portal_only' | 'invited';

interface PersonContact {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  roleId: string | null;
  isPrimary: boolean;
  isBilling: boolean;
  receiveAppointmentReminders?: boolean;
  // 0115 — other clients this same person is also a contact of.
  alsoOn?: { clientId: string; name: string }[];
}
interface PersonAccess {
  id: string;
  portalIdentityId: string;
  role: Role;
  status: 'INVITED' | 'ACTIVE' | 'INACTIVE';
  fullName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  lastLoginAt: string | null;
}
interface PersonInvite {
  id: string;
  proposedFullName: string;
  invitedEmail: string | null;
  invitedPhone: string | null;
  proposedRole: Role;
  expiresAt: string;
}
interface Person {
  key: string;
  kind: Kind;
  contact: PersonContact | null;
  access: PersonAccess | null;
  pendingInvitation: PersonInvite | null;
}

interface RoleEntry {
  id: string;
  name: string;
  status: string;
}

const ROLE_OPTIONS: ComboboxOption[] = [
  { value: 'FULL', label: 'Full access' },
  { value: 'VIEW_ONLY', label: 'View only' },
  { value: 'PAY_ONLY', label: 'Pay only' },
];
const ROLE_LABEL: Record<Role, string> = {
  FULL: 'Full access',
  VIEW_ONLY: 'View only',
  PAY_ONLY: 'Pay only',
};

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

function nameOf(p: Person): string {
  return (
    p.contact?.fullName ?? p.access?.fullName ?? p.pendingInvitation?.proposedFullName ?? 'Unknown'
  );
}

export function PeopleCard({ clientId }: { clientId: string }): JSX.Element {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'add-contact' | 'invite'>('none');
  // When inviting from a specific contact row, prefill + link it.
  const [inviteSeed, setInviteSeed] = useState<PersonContact | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ people: Person[] }>(`/api/staff/clients/${clientId}/people`);
      setPeople(r.people ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
      setPeople([]);
    }
  }

  useEffect(() => {
    void load();
    void api<{ items: RoleEntry[] }>('/api/staff/taxonomy/contact-roles')
      .then((r) => setRoles((r.items ?? []).filter((x) => x.status === 'ACTIVE')))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  function reset(msg?: string): void {
    setMode('none');
    setInviteSeed(null);
    setExpandedKey(null);
    if (msg) setNotice(msg);
    void load();
  }

  async function act(key: string, fn: () => Promise<void>, ok?: string): Promise<void> {
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      reset(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'action_failed');
    } finally {
      setBusyKey(null);
    }
  }

  async function viewAs(accessId: string): Promise<void> {
    setBusyKey(accessId);
    setError(null);
    try {
      const r = await api<{ portalUrl: string }>(`/api/staff/clients/${clientId}/impersonate`, {
        method: 'POST',
        body: JSON.stringify({ accessId }),
      });
      window.open(r.portalUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(`Could not start view-as: ${e instanceof Error ? e.message : 'failed'}`);
    } finally {
      setBusyKey(null);
    }
  }

  const roleName = (id: string | null): string | null =>
    id ? (roles.find((r) => r.id === id)?.name ?? null) : null;

  return (
    <Card
      title={`People${people ? ` (${people.length})` : ''}`}
      action={
        <div style={{ display: 'flex', gap: 6 }}>
          <Button
            size="sm"
            variant={mode === 'add-contact' ? 'ghost' : 'secondary'}
            onClick={() => {
              setMode((m) => (m === 'add-contact' ? 'none' : 'add-contact'));
              setInviteSeed(null);
            }}
          >
            {mode === 'add-contact' ? 'Cancel' : '+ Add contact'}
          </Button>
          <Button
            size="sm"
            variant={mode === 'invite' ? 'ghost' : 'secondary'}
            onClick={() => {
              setMode((m) => (m === 'invite' ? 'none' : 'invite'));
              setInviteSeed(null);
            }}
          >
            {mode === 'invite' ? 'Cancel' : '+ Invite to portal'}
          </Button>
        </div>
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

      {mode === 'add-contact' && (
        <AddContactForm
          clientId={clientId}
          roles={roles}
          onError={setError}
          onCreated={() => reset('Contact added.')}
        />
      )}
      {mode === 'invite' && (
        <InviteForm
          clientId={clientId}
          seed={inviteSeed}
          onError={setError}
          onCreated={() => reset('Invitation sent.')}
        />
      )}

      {people == null ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
      ) : people.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          No people yet. Add a contact, or invite someone to the portal.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {people.map((p) => {
            const a = p.access;
            const c = p.contact;
            const inv = p.pendingInvitation;
            const email = c?.email ?? a?.primaryEmail ?? inv?.invitedEmail ?? null;
            const phone = c?.phone ?? a?.primaryPhone ?? inv?.invitedPhone ?? null;
            const expanded = expandedKey === p.key;
            const busy = busyKey === p.key || busyKey === a?.id || busyKey === c?.id;
            return (
              <div
                key={p.key}
                style={{
                  padding: 12,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 14 }}>{nameOf(p)}</strong>
                  {roleName(c?.roleId ?? null) && <Pill>{roleName(c?.roleId ?? null)}</Pill>}
                  {c?.isPrimary && <Pill tone="accent">Primary</Pill>}
                  {c?.isBilling && <Pill tone="success">Billing</Pill>}

                  {/* Portal status */}
                  {a ? (
                    <>
                      <Pill
                        tone={
                          a.status === 'ACTIVE'
                            ? 'success'
                            : a.status === 'INVITED'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        Portal: {ROLE_LABEL[a.role]}
                        {a.status !== 'ACTIVE' ? ` (${a.status})` : ''}
                      </Pill>
                    </>
                  ) : inv ? (
                    <Pill tone="warning">Invited — awaiting acceptance</Pill>
                  ) : (
                    <Pill tone="neutral">No portal access</Pill>
                  )}
                  {p.kind === 'portal_only' && <Pill tone="warning">Not in contacts</Pill>}

                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {/* Invite a contact who has no access */}
                    {!a && !inv && c && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          setInviteSeed(c);
                          setMode('invite');
                        }}
                      >
                        Invite to portal
                      </Button>
                    )}
                    {/* 3rd party — pull into the directory */}
                    {p.kind === 'portal_only' && a && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            p.key,
                            () =>
                              api(`/api/staff/portal-invites/access/${a.id}/add-contact`, {
                                method: 'POST',
                                body: '{}',
                              }),
                            'Added to contacts.',
                          )
                        }
                      >
                        Add to contacts
                      </Button>
                    )}
                    {/* View as client */}
                    {a && a.status === 'ACTIVE' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void viewAs(a.id)}
                      >
                        View as ↗
                      </Button>
                    )}
                    {/* Resend pending */}
                    {inv && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            p.key,
                            () =>
                              api(`/api/staff/portal-invites/${inv.id}/resend`, {
                                method: 'POST',
                                body: '{}',
                              }),
                            'Invitation re-sent.',
                          )
                        }
                      >
                        Resend
                      </Button>
                    )}
                    {(c || a) && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setExpandedKey((k) => (k === p.key ? null : p.key))}
                      >
                        {expanded ? 'Close' : 'Manage'}
                      </Button>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
                  {email && (
                    <a
                      href={`mailto:${email}`}
                      style={{ color: tokens.color.accent, textDecoration: 'none' }}
                    >
                      {email}
                    </a>
                  )}
                  {phone && <span style={{ color: tokens.color.textMuted }}>{phone}</span>}
                  {a?.lastLoginAt && (
                    <span style={{ color: tokens.color.textMuted }}>
                      last signed in {a.lastLoginAt.slice(0, 10)}
                    </span>
                  )}
                </div>

                {c?.alsoOn && c.alsoOn.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Also on:</span>
                    {c.alsoOn.map((o) => (
                      <a
                        key={o.clientId}
                        href={`/clients/${o.clientId}`}
                        style={{ fontSize: 11, color: tokens.color.accent, textDecoration: 'none' }}
                      >
                        {o.name}
                      </a>
                    ))}
                  </div>
                )}

                {expanded && (
                  <ManagePanel
                    clientId={clientId}
                    person={p}
                    roles={roles}
                    busy={busy}
                    onError={setError}
                    onChanged={(msg) => reset(msg)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// --- Manage panel (edit contact + access role/revoke) ----------------

function ManagePanel({
  clientId,
  person,
  roles,
  busy,
  onError,
  onChanged,
}: {
  clientId: string;
  person: Person;
  roles: RoleEntry[];
  busy: boolean;
  onError: (m: string) => void;
  onChanged: (msg?: string) => void;
}): JSX.Element {
  const c = person.contact;
  const a = person.access;
  const [fullName, setFullName] = useState(c?.fullName ?? '');
  const [email, setEmail] = useState(c?.email ?? '');
  const [phone, setPhone] = useState(c?.phone ?? '');
  const [roleId, setRoleId] = useState(c?.roleId ?? '');
  const [role, setRole] = useState<Role>(a?.role ?? 'FULL');
  const [saving, setSaving] = useState(false);

  async function saveContact(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!c) return;
    setSaving(true);
    onError('');
    try {
      await api(`/api/staff/clients/${clientId}/contacts/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          fullName,
          email: email || null,
          phone: phone || null,
          roleId: roleId || null,
        }),
      });
      onChanged('Contact updated.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  async function changeRole(): Promise<void> {
    if (!a || role === a.role) return;
    setSaving(true);
    onError('');
    try {
      await api(`/api/staff/portal-invites/access/${a.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      onChanged('Portal role updated.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'role_failed');
    } finally {
      setSaving(false);
    }
  }

  async function setFlag(flag: 'isPrimary' | 'isBilling'): Promise<void> {
    if (!c) return;
    setSaving(true);
    onError('');
    try {
      await api(`/api/staff/clients/${clientId}/contacts/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [flag]: true }),
      });
      onChanged('Updated.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'flag_failed');
    } finally {
      setSaving(false);
    }
  }

  async function toggleReminders(next: boolean): Promise<void> {
    if (!c) return;
    setSaving(true);
    onError('');
    try {
      await api(`/api/staff/clients/${clientId}/contacts/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ receiveAppointmentReminders: next }),
      });
      onChanged('Updated.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'flag_failed');
    } finally {
      setSaving(false);
    }
  }

  async function removeContact(): Promise<void> {
    if (!c || !window.confirm('Remove this contact from the directory?')) return;
    setSaving(true);
    onError('');
    try {
      await api(`/api/staff/clients/${clientId}/contacts/${c.id}`, { method: 'DELETE' });
      onChanged('Contact removed.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'remove_failed');
    } finally {
      setSaving(false);
    }
  }

  async function revokeRestore(): Promise<void> {
    if (!a) return;
    const restoring = a.status === 'INACTIVE';
    if (
      !restoring &&
      !window.confirm(`Revoke portal access for ${a.fullName}? They'll be signed out.`)
    )
      return;
    setSaving(true);
    onError('');
    try {
      await api(`/api/staff/portal-invites/access/${a.id}/${restoring ? 'restore' : 'revoke'}`, {
        method: 'POST',
        body: '{}',
      });
      onChanged(restoring ? 'Access restored.' : 'Access revoked.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'revoke_failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        borderTop: `1px solid ${tokens.color.border}`,
        paddingTop: 12,
        marginTop: 4,
        display: 'grid',
        gap: 12,
      }}
    >
      {c && (
        <form onSubmit={saveContact} style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Directory contact — name, email &amp; phone are shared by this person across every
            client they belong to, so edits here apply everywhere.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input
              style={fieldStyle}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Full name"
            />
            <Combobox
              ariaLabel="Role"
              clearable
              value={roleId}
              onChange={setRoleId}
              options={roles.map<ComboboxOption>((r) => ({ value: r.id, label: r.name }))}
              placeholder="Role…"
            />
            <input
              style={fieldStyle}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
            />
            <input
              style={fieldStyle}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Phone"
            />
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Button type="submit" size="sm" disabled={saving}>
              Save contact
            </Button>
            {!c.isPrimary && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void setFlag('isPrimary')}
              >
                Set primary
              </Button>
            )}
            {!c.isBilling && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void setFlag('isBilling')}
              >
                Set billing
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => void removeContact()}
            >
              Remove contact
            </Button>
          </div>
          <label
            style={{
              display: 'inline-flex',
              gap: 6,
              alignItems: 'center',
              fontSize: 12,
              marginTop: 4,
            }}
          >
            <input
              type="checkbox"
              checked={c.receiveAppointmentReminders !== false}
              disabled={saving}
              onChange={(e) => void toggleReminders(e.target.checked)}
            />
            Send appointment reminders to this contact
          </label>
        </form>
      )}

      {a && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Portal login — {a.primaryEmail ?? a.primaryPhone ?? '—'}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 180 }}>
              <Combobox
                ariaLabel="Portal role"
                value={role}
                onChange={(v) => setRole(v as Role)}
                options={ROLE_OPTIONS}
              />
            </div>
            <Button
              size="sm"
              disabled={saving || role === a.role}
              onClick={() => void changeRole()}
            >
              Update role
            </Button>
            <Button
              size="sm"
              variant={a.status === 'INACTIVE' ? 'primary' : 'danger'}
              disabled={saving || busy}
              onClick={() => void revokeRestore()}
            >
              {a.status === 'INACTIVE' ? 'Restore access' : 'Revoke access'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Add-contact form -------------------------------------------------

function AddContactForm({
  clientId,
  roles,
  onError,
  onCreated,
}: {
  clientId: string;
  roles: RoleEntry[];
  onError: (m: string) => void;
  onCreated: () => void;
}): JSX.Element {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!fullName.trim()) return;
    setBusy(true);
    onError('');
    try {
      await api(`/api/staff/clients/${clientId}/contacts`, {
        method: 'POST',
        body: JSON.stringify({
          fullName: fullName.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          roleId: roleId || null,
        }),
      });
      onCreated();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        gap: 8,
        padding: 12,
        marginBottom: 12,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
      }}
    >
      <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Add a directory contact (no login). Invite them to the portal separately when ready.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <input
          style={fieldStyle}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          placeholder="Full name *"
        />
        <Combobox
          ariaLabel="Role"
          clearable
          value={roleId}
          onChange={setRoleId}
          options={roles.map<ComboboxOption>((r) => ({ value: r.id, label: r.name }))}
          placeholder="Role…"
        />
        <input
          style={fieldStyle}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
        />
        <input
          style={fieldStyle}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone"
        />
      </div>
      <div>
        <Button size="sm" disabled={busy || !fullName.trim()} onClick={() => void submit()}>
          Add contact
        </Button>
      </div>
    </div>
  );
}

// --- Invite form ------------------------------------------------------

function InviteForm({
  clientId,
  seed,
  onError,
  onCreated,
}: {
  clientId: string;
  seed: PersonContact | null;
  onError: (m: string) => void;
  onCreated: () => void;
}): JSX.Element {
  const [fullName, setFullName] = useState(seed?.fullName ?? '');
  const [email, setEmail] = useState(seed?.email ?? '');
  const [phone, setPhone] = useState(seed?.phone ?? '');
  const [role, setRole] = useState<Role>('FULL');
  const [channel, setChannel] = useState<'EMAIL' | 'SMS'>('EMAIL');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    onError('');
    try {
      const body: Record<string, unknown> = {
        clientId,
        fullName: fullName.trim(),
        role,
        deliveryChannel: channel,
      };
      if (email.trim()) body['email'] = email.trim();
      if (phone.trim()) body['phone'] = phone.trim();
      if (seed) body['clientContactId'] = seed.id;
      await api('/api/staff/portal-invites', { method: 'POST', body: JSON.stringify(body) });
      onCreated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invite_failed';
      onError(
        msg === 'invalid_payload'
          ? 'Name plus either email or phone is required.'
          : `Invite failed: ${msg}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{
        display: 'grid',
        gap: 10,
        padding: 12,
        marginBottom: 12,
        background: tokens.color.surface,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
      }}
    >
      <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
        {seed
          ? `Invite ${seed.fullName} to the portal. They'll be linked to this contact.`
          : 'Invite someone to the portal. If they match a contact by email they’ll be linked; otherwise they’re added as a portal-only (3rd-party) login.'}
      </div>
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
            Send via
          </label>
          <Combobox
            ariaLabel="Delivery channel"
            value={channel}
            onChange={(v) => setChannel(v as 'EMAIL' | 'SMS')}
            options={[
              { value: 'EMAIL', label: 'Email' },
              { value: 'SMS', label: 'Text message' },
            ]}
          />
        </div>
      </div>
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={busy || !fullName.trim() || (!email.trim() && !phone.trim())}
        >
          {busy ? 'Sending…' : 'Send invitation'}
        </Button>
      </div>
    </form>
  );
}
