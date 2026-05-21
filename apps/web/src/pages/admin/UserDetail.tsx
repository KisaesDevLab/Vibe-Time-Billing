// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin user detail page (v2 Sprint E, workstream 3.5). Replaces the
// invite/list-only Users.tsx for individual user inspection. Sections:
//   Profile · Roles · Authentication · Lifecycle
//
// Routes from /admin/users by clicking a user row; backend supports the
// underlying endpoints already (GET /admin/users/:id, PATCH, POST
// /admin/users/:id/reset-totp, PATCH /admin/users/:id/archive).

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button, Card, Combobox, Pill, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../../api-client';

interface User {
  id: string;
  email: string;
  fullName: string;
  defaultOfficeId: string | null;
  status: string;
  totpEnrolledAt: string | null;
  standardHoursPerWeek: string;
  billableTargetHoursPerMonth: number | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface RoleAssignment {
  roleId: string;
  roleSlug: string;
  roleName: string;
}

interface RoleOption {
  id: string;
  slug: string;
  name: string;
}

interface Office {
  id: string;
  name: string;
}

const fieldStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
  width: '100%',
};

export function UserDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  const [allRoles, setAllRoles] = useState<RoleOption[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<User>>({});
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    if (!id) return;
    try {
      const [u, r, ar, o] = await Promise.all([
        api<{ user: User }>(`/api/staff/admin/users/${id}`),
        api<{ roles: RoleAssignment[] }>(`/api/staff/admin/users/${id}/roles`),
        api<{ roles: RoleOption[] }>(`/api/staff/admin/roles`),
        api<{ offices: Office[] }>('/api/staff/admin/offices'),
      ]);
      setUser(u.user);
      setRoles(r.roles ?? []);
      setAllRoles(ar.roles ?? []);
      setOffices(o.offices ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function saveProfile(): Promise<void> {
    if (!id) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(draft),
      });
      setEditing(false);
      setStatus('Profile saved.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function resetTotp(): Promise<void> {
    if (!id) return;
    if (!confirm('Reset TOTP? The user must re-enroll at next sign-in.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}/reset-totp`, { method: 'POST' });
      setStatus('TOTP reset. User must re-enroll next sign-in.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'reset_failed');
    } finally {
      setBusy(false);
    }
  }

  async function archive(): Promise<void> {
    if (!id) return;
    if (!confirm('Archive this user? They will be unable to sign in.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}/archive`, { method: 'PATCH' });
      setStatus('User archived.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    } finally {
      setBusy(false);
    }
  }

  async function assignRole(roleId: string): Promise<void> {
    if (!id || !roleId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/users/${id}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleId }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'assign_failed');
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <Card title="User">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>{error ?? 'Loading…'}</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      {status && (
        <p style={{ color: tokens.color.success, fontSize: 12 }} role="status">
          {status}
        </p>
      )}
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
          {error}
        </p>
      )}

      <Card
        title={
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span>{user.fullName}</span>
            <Pill tone={user.status === 'ACTIVE' ? 'success' : 'warning'}>{user.status}</Pill>
          </span>
        }
        action={
          editing ? (
            <span style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" onClick={() => void saveProfile()} disabled={busy}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setDraft({});
                }}
              >
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(true);
                setDraft({});
              }}
            >
              Edit
            </Button>
          )
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
              Full name
            </div>
            {editing ? (
              <input
                defaultValue={user.fullName}
                onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
                style={fieldStyle}
              />
            ) : (
              <div style={{ fontSize: 14 }}>{user.fullName}</div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
              Email
            </div>
            <div style={{ fontSize: 14 }}>{user.email}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
              Default office
            </div>
            {editing ? (
              <Combobox
                ariaLabel="Default office"
                clearable
                value={(draft.defaultOfficeId ?? user.defaultOfficeId ?? '') as string}
                onChange={(val) => setDraft({ ...draft, defaultOfficeId: val || null })}
                options={offices.map<ComboboxOption>((o) => ({ value: o.id, label: o.name }))}
                placeholder="— none —"
              />
            ) : (
              <div style={{ fontSize: 14 }}>
                {offices.find((o) => o.id === user.defaultOfficeId)?.name ?? '—'}
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
              Standard hours / week
            </div>
            {editing ? (
              <input
                type="number"
                step={0.5}
                defaultValue={user.standardHoursPerWeek}
                onChange={(e) => setDraft({ ...draft, standardHoursPerWeek: e.target.value })}
                style={fieldStyle}
              />
            ) : (
              <div style={{ fontSize: 14 }}>{user.standardHoursPerWeek}</div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
              Billable target / month
            </div>
            {editing ? (
              <input
                type="number"
                defaultValue={user.billableTargetHoursPerMonth ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    billableTargetHoursPerMonth: e.target.value ? Number(e.target.value) : null,
                  })
                }
                placeholder="(inherit firm default)"
                style={fieldStyle}
              />
            ) : (
              <div style={{ fontSize: 14 }}>
                {user.billableTargetHoursPerMonth ?? '(firm default)'}
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
              Last login
            </div>
            <div style={{ fontSize: 14 }}>
              {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="Roles"
        action={
          <div style={{ width: 220 }}>
            <Combobox
              ariaLabel="Assign role"
              disabled={busy}
              value=""
              onChange={(val) => {
                if (val) void assignRole(val);
              }}
              options={allRoles
                .filter((r) => !roles.some((cur) => cur.roleId === r.id))
                .map<ComboboxOption>((r) => ({ value: r.id, label: r.name }))}
              placeholder="+ Assign role…"
              size="sm"
            />
          </div>
        }
      >
        {roles.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No roles assigned. User has read-only baseline access until at least one role is
            attached.
          </p>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {roles.map((r) => (
              <Pill key={r.roleId} tone="accent">
                {r.roleName} <code style={{ fontSize: 10, opacity: 0.6 }}>{r.roleSlug}</code>
              </Pill>
            ))}
          </div>
        )}
      </Card>

      <Card title="Authentication">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 13 }}>
              TOTP:{' '}
              {user.totpEnrolledAt ? (
                <Pill tone="success">enrolled</Pill>
              ) : (
                <Pill tone="warning">not enrolled</Pill>
              )}
            </div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>
              {user.totpEnrolledAt
                ? `Enrolled ${new Date(user.totpEnrolledAt).toLocaleDateString()}`
                : 'Required at first sign-in (locked decision #5).'}
            </div>
          </div>
          {user.totpEnrolledAt && (
            <Button size="sm" variant="secondary" onClick={() => void resetTotp()} disabled={busy}>
              Reset TOTP
            </Button>
          )}
        </div>
      </Card>

      <Card title="Lifecycle">
        <div style={{ display: 'flex', gap: 8 }}>
          {user.status === 'ACTIVE' && (
            <Button variant="secondary" onClick={() => void archive()} disabled={busy}>
              Archive
            </Button>
          )}
          <span style={{ fontSize: 12, color: tokens.color.textMuted, alignSelf: 'center' }}>
            Created {new Date(user.createdAt).toLocaleDateString()}
          </span>
        </div>
      </Card>
    </div>
  );
}
