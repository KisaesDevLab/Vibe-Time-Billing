// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Client contacts card for ClientDetail Home tab (v2 Sprint B,
// workstream 1.6). Lists every client_contact row with inline edit
// affordances: set primary, set billing, edit, remove, add.
//
// The primary/billing flags are partial-unique-per-client at the DB
// level (migration 0027), so flipping them on one contact automatically
// clears the flag on siblings via the PATCH handler.

import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Pill, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';

interface Contact {
  id: string;
  fullName: string;
  roleId: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
  isBilling: boolean;
  isPortalIdentity: boolean;
}

interface RoleEntry {
  id: string;
  key: string;
  name: string;
  status: string;
}

interface Props {
  clientId: string;
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

export function ContactsCard({ clientId }: Props): JSX.Element {
  const [items, setItems] = useState<Contact[]>([]);
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    fullName: '',
    email: '',
    phone: '',
    mobile: '',
    roleId: '',
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Partial<Contact>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: Contact[] }>(`/api/staff/clients/${clientId}/contacts`);
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void (async () => {
      await load();
      try {
        const r = await api<{ items: RoleEntry[] }>('/api/staff/taxonomy/contact-roles');
        setRoles((r.items ?? []).filter((x) => x.status === 'ACTIVE'));
      } catch {
        // Non-fatal.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function add(): Promise<void> {
    if (!draft.fullName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/clients/${clientId}/contacts`, {
        method: 'POST',
        body: JSON.stringify({
          fullName: draft.fullName.trim(),
          email: draft.email.trim() || null,
          phone: draft.phone.trim() || null,
          mobile: draft.mobile.trim() || null,
          roleId: draft.roleId || null,
        }),
      });
      setDraft({ fullName: '', email: '', phone: '', mobile: '', roleId: '' });
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Partial<Contact>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/clients/${clientId}/contacts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'patch_failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (!confirm('Remove this contact?')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/clients/${clientId}/contacts/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'remove_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={`Contacts (${items.length})`}
      action={
        <Button size="sm" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : '+ Add contact'}
        </Button>
      }
    >
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}

      {adding && (
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <input
              value={draft.fullName}
              onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
              placeholder="Full name *"
              style={fieldStyle}
            />
            <Combobox
              ariaLabel="Role"
              clearable
              value={draft.roleId}
              onChange={(val) => setDraft({ ...draft, roleId: val })}
              options={roles.map<ComboboxOption>((r) => ({ value: r.id, label: r.name }))}
              placeholder="Role…"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <input
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              placeholder="Email"
              style={fieldStyle}
            />
            <input
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              placeholder="Phone"
              style={fieldStyle}
            />
            <input
              value={draft.mobile}
              onChange={(e) => setDraft({ ...draft, mobile: e.target.value })}
              placeholder="Mobile"
              style={fieldStyle}
            />
          </div>
          <div>
            <Button size="sm" onClick={() => void add()} disabled={busy || !draft.fullName.trim()}>
              Add contact
            </Button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No contacts. Add a primary contact to start.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map((c) => {
            const isEditing = editingId === c.id;
            const role = roles.find((r) => r.id === c.roleId)?.name;
            return (
              <div
                key={c.id}
                style={{
                  padding: 12,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {isEditing ? (
                    <input
                      value={editDraft.fullName ?? c.fullName}
                      onChange={(e) => setEditDraft({ ...editDraft, fullName: e.target.value })}
                      style={fieldStyle}
                    />
                  ) : (
                    <strong style={{ fontSize: 14 }}>{c.fullName}</strong>
                  )}
                  {role && <Pill>{role}</Pill>}
                  {c.isPrimary && <Pill tone="accent">Primary</Pill>}
                  {c.isBilling && <Pill tone="success">Billing</Pill>}
                  {c.isPortalIdentity && <Pill tone="warning">Portal</Pill>}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {!isEditing && !c.isPrimary && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void patch(c.id, { isPrimary: true })}
                        disabled={busy}
                      >
                        Set primary
                      </Button>
                    )}
                    {!isEditing && !c.isBilling && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void patch(c.id, { isBilling: true })}
                        disabled={busy}
                      >
                        Set billing
                      </Button>
                    )}
                    {!isEditing && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(c.id);
                          setEditDraft({});
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    {isEditing && (
                      <>
                        <Button
                          size="sm"
                          onClick={() =>
                            void (async () => {
                              await patch(c.id, editDraft);
                              setEditingId(null);
                              setEditDraft({});
                            })()
                          }
                          disabled={busy}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditingId(null);
                            setEditDraft({});
                          }}
                        >
                          Cancel
                        </Button>
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void remove(c.id)}
                      disabled={busy}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
                  {isEditing ? (
                    <>
                      <input
                        defaultValue={c.email ?? ''}
                        onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })}
                        placeholder="Email"
                        style={{ ...fieldStyle, minWidth: 200 }}
                      />
                      <input
                        defaultValue={c.phone ?? ''}
                        onChange={(e) => setEditDraft({ ...editDraft, phone: e.target.value })}
                        placeholder="Phone"
                        style={{ ...fieldStyle, minWidth: 140 }}
                      />
                      <input
                        defaultValue={c.mobile ?? ''}
                        onChange={(e) => setEditDraft({ ...editDraft, mobile: e.target.value })}
                        placeholder="Mobile"
                        style={{ ...fieldStyle, minWidth: 140 }}
                      />
                    </>
                  ) : (
                    <>
                      {c.email && (
                        <a
                          href={`mailto:${c.email}`}
                          style={{ color: tokens.color.accent, textDecoration: 'none' }}
                        >
                          {c.email}
                        </a>
                      )}
                      {c.phone && <span style={{ color: tokens.color.textMuted }}>{c.phone}</span>}
                      {c.mobile && (
                        <span style={{ color: tokens.color.textMuted }}>{c.mobile} (mobile)</span>
                      )}
                      {!c.email && !c.phone && !c.mobile && (
                        <span style={{ color: tokens.color.textMuted, fontStyle: 'italic' }}>
                          No contact info.
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
