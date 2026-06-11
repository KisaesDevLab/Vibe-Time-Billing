// SPDX-License-Identifier: Elastic-2.0
//
// Person detail (0115 follow-up). Edits a firm person's canonical name /
// email / phone (changes propagate to every client they're a contact of),
// and manages their portal access per client — enable (one-click grant,
// Full/email defaults), disable, restore, change role, resend invite.
//
// Reads GET /api/staff/people/:id. Edits go to PATCH /api/staff/people/:id;
// portal access reuses the /api/staff/portal-invites endpoints.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Combobox, Pill, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';
import { usePermission } from '../auth-context';

type Role = 'FULL' | 'VIEW_ONLY' | 'PAY_ONLY';

const ROLE_OPTIONS: ComboboxOption[] = [
  { value: 'FULL', label: 'Full access' },
  { value: 'VIEW_ONLY', label: 'View only' },
  { value: 'PAY_ONLY', label: 'Pay only' },
];

interface ClientEntry {
  clientId: string;
  clientName: string;
  contactId: string | null;
  accessId: string | null;
  accessStatus: 'ACTIVE' | 'INACTIVE' | 'INVITED' | null;
  role: Role | null;
  invitationId: string | null;
}
interface PersonDetail {
  kind: 'person' | 'portal_identity';
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  status: string;
  clients: ClientEntry[];
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

export function PersonDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyClient, setBusyClient] = useState<string | null>(null);
  // View-as mirrors the impersonate endpoint's gate (engagement:read —
  // partner/manager/senior; plain staff don't see the button).
  const canViewAs = usePermission('engagement:read');

  async function viewAs(clientId: string, accessId: string): Promise<void> {
    try {
      const r = await api<{ portalUrl: string }>(`/api/staff/clients/${clientId}/impersonate`, {
        method: 'POST',
        body: JSON.stringify({ accessId }),
      });
      window.open(r.portalUrl, '_blank', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'impersonation_failed');
    }
  }

  async function load(): Promise<void> {
    try {
      const r = await api<PersonDetail>(`/api/staff/people/${id}`);
      setPerson(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function act(clientId: string, fn: () => Promise<void>, ok: string): Promise<void> {
    setBusyClient(clientId);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
      setNotice(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'action_failed');
    } finally {
      setBusyClient(null);
    }
  }

  if (!person) {
    return (
      <div style={{ padding: 24 }}>
        {error ? (
          <p style={{ color: tokens.color.danger }} role="alert">
            {error}
          </p>
        ) : (
          <p style={{ color: tokens.color.textMuted }}>Loading…</p>
        )}
      </div>
    );
  }

  const canEnable = Boolean(person.email || person.phone);
  // Person rows can be linked to their contact; standalone identities can't.
  const personIdForGrant = person.kind === 'person' ? person.id : undefined;

  async function enable(clientId: string): Promise<void> {
    if (!person) return;
    const body: Record<string, unknown> = {
      clientId,
      fullName: person.fullName,
      role: 'FULL',
      deliveryChannel: 'EMAIL',
    };
    if (person.email) body['email'] = person.email;
    if (person.phone) body['phone'] = person.phone;
    if (personIdForGrant) body['personId'] = personIdForGrant;
    await api('/api/staff/portal-invites', { method: 'POST', body: JSON.stringify(body) });
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Button variant="ghost" size="sm" onClick={() => navigate('/people')}>
        ← All people
      </Button>

      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }} role="alert">
          {error}
        </p>
      )}
      {notice && <p style={{ color: tokens.color.success, fontSize: 13, margin: 0 }}>{notice}</p>}

      <EditHeader
        person={person}
        onSaved={(msg) => {
          setNotice(msg);
          void load();
        }}
        onError={setError}
      />

      <Card title={`Clients (${person.clients.length})`}>
        {person.clients.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            Not associated with any client yet.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {person.clients.map((c) => {
              const busy = busyClient === c.clientId;
              return (
                <div
                  key={c.clientId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                    padding: '10px 12px',
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                  }}
                >
                  <a
                    href={`/clients/${c.clientId}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/clients/${c.clientId}`);
                    }}
                    style={{ fontSize: 14, fontWeight: 600, color: tokens.color.accent }}
                  >
                    {c.clientName}
                  </a>
                  {c.contactId ? (
                    <Pill tone="neutral">Contact</Pill>
                  ) : (
                    <Pill tone="warning">Portal-only</Pill>
                  )}

                  <div
                    style={{
                      marginLeft: 'auto',
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    {c.accessStatus === 'ACTIVE' && c.accessId ? (
                      <>
                        <div style={{ minWidth: 150 }}>
                          <Combobox
                            ariaLabel="Portal role"
                            value={c.role ?? 'FULL'}
                            onChange={(v) =>
                              void act(
                                c.clientId,
                                () =>
                                  api(`/api/staff/portal-invites/access/${c.accessId}`, {
                                    method: 'PATCH',
                                    body: JSON.stringify({ role: v }),
                                  }),
                                'Portal role updated.',
                              )
                            }
                            options={ROLE_OPTIONS}
                          />
                        </div>
                        <Pill tone="success">Enabled</Pill>
                        {canViewAs && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            title="Open the portal as this person (read-only impersonation, 5-min token)"
                            onClick={() => void viewAs(c.clientId, c.accessId!)}
                          >
                            View as
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              c.clientId,
                              () =>
                                api(`/api/staff/portal-invites/access/${c.accessId}/revoke`, {
                                  method: 'POST',
                                  body: '{}',
                                }),
                              'Portal access disabled.',
                            )
                          }
                        >
                          Disable
                        </Button>
                      </>
                    ) : c.accessStatus === 'INACTIVE' && c.accessId ? (
                      <>
                        <Pill tone="neutral">Disabled</Pill>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              c.clientId,
                              () =>
                                api(`/api/staff/portal-invites/access/${c.accessId}/restore`, {
                                  method: 'POST',
                                  body: '{}',
                                }),
                              'Portal access enabled.',
                            )
                          }
                        >
                          Enable
                        </Button>
                      </>
                    ) : c.accessStatus === 'INVITED' ? (
                      <>
                        <Pill tone="warning">Invited</Pill>
                        {c.invitationId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                c.clientId,
                                () =>
                                  api(`/api/staff/portal-invites/${c.invitationId}/resend`, {
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
                      </>
                    ) : (
                      <>
                        <Pill tone="neutral">No portal access</Pill>
                        <Button
                          size="sm"
                          disabled={busy || !canEnable}
                          title={
                            canEnable ? undefined : 'Add an email or phone to this person first'
                          }
                          onClick={() =>
                            void act(c.clientId, () => enable(c.clientId), 'Portal access enabled.')
                          }
                        >
                          Enable
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// --- Editable identity header ----------------------------------------

function EditHeader({
  person,
  onSaved,
  onError,
}: {
  person: PersonDetail;
  onSaved: (msg: string) => void;
  onError: (m: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(person.fullName);
  const [email, setEmail] = useState(person.email ?? '');
  const [phone, setPhone] = useState(person.phone ?? '');
  const [mobile, setMobile] = useState(person.mobile ?? '');
  const [saving, setSaving] = useState(false);

  function begin(): void {
    setFullName(person.fullName);
    setEmail(person.email ?? '');
    setPhone(person.phone ?? '');
    setMobile(person.mobile ?? '');
    setEditing(true);
  }

  async function save(): Promise<void> {
    setSaving(true);
    onError('');
    try {
      const body: Record<string, unknown> = {
        fullName: fullName.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
      };
      if (person.kind === 'person') body['mobile'] = mobile.trim() || null;
      await api(`/api/staff/people/${person.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setEditing(false);
      onSaved('Saved.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'save_failed';
      onError(msg === 'email_in_use' ? 'Another person in the firm already uses that email.' : msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title={person.fullName}
      action={
        editing ? (
          <div style={{ display: 'flex', gap: 6 }}>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving || !fullName.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={begin}>
            Edit
          </Button>
        )
      }
    >
      {person.kind === 'portal_identity' && (
        <p style={{ fontSize: 11, color: tokens.color.warning, marginTop: 0 }}>
          Portal-only login — not in the directory.
        </p>
      )}
      {editing ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Name, email &amp; phone are shared by this person across every client — edits apply
            everywhere.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input
              style={fieldStyle}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Full name"
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
            {person.kind === 'person' && (
              <input
                style={fieldStyle}
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="Mobile"
              />
            )}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 20, fontSize: 13, flexWrap: 'wrap' }}>
          <span>
            <span style={{ color: tokens.color.textMuted }}>Email: </span>
            {person.email ?? '—'}
          </span>
          <span>
            <span style={{ color: tokens.color.textMuted }}>Phone: </span>
            {person.phone ?? '—'}
          </span>
          {person.kind === 'person' && (
            <span>
              <span style={{ color: tokens.color.textMuted }}>Mobile: </span>
              {person.mobile ?? '—'}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
