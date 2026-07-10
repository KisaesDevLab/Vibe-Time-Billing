// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface User {
  id: string;
  email: string;
  fullName: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  totpEnrolledAt: string | null;
  standardHoursPerWeek?: string | number | null;
  billableTargetHoursPerMonth?: number | null;
}

export function UsersPage(): JSX.Element {
  const navigate = useNavigate();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviting, setInviting] = useState(false);

  async function load(): Promise<void> {
    try {
      const r = await api<{ users: User[] }>('/api/staff/admin/users');
      setUsers(r.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function invite(e: FormEvent): Promise<void> {
    e.preventDefault();
    setInviting(true);
    setError(null);
    try {
      await api('/api/staff/admin/users/invite', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail, fullName: inviteName }),
      });
      setInviteEmail('');
      setInviteName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'invite failed');
    } finally {
      setInviting(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card title="Invite staff">
        <form
          onSubmit={invite}
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: '1fr 1fr auto',
            alignItems: 'end',
          }}
        >
          <Input
            label="Full name"
            value={inviteName}
            onChange={(e) => setInviteName(e.target.value)}
            required
          />
          <Input
            type="email"
            label="Email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            required
          />
          <Button type="submit" disabled={inviting}>
            {inviting ? 'Sending…' : 'Send invite'}
          </Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Staff">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 12px' }}>
          Click a staff member&apos;s name to open their profile, where you can set{' '}
          <strong>billing rates</strong> (Rates tab), targets, skills, and contact info.
        </p>
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<User>
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (u) => (
                  <button
                    onClick={() => navigate(`/admin/users/${u.id}`)}
                    title="Open profile, rates & targets"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: tokens.color.accent,
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 600,
                      padding: 0,
                      textAlign: 'left',
                    }}
                  >
                    {u.fullName}
                  </button>
                ),
              },
              { key: 'email', header: 'Email', render: (u) => u.email },
              {
                key: 'totp',
                header: 'TOTP',
                render: (u) => (
                  <Pill tone={u.totpEnrolledAt ? 'success' : 'warning'}>
                    {u.totpEnrolledAt ? 'enrolled' : 'pending'}
                  </Pill>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (u) => (
                  <Pill tone={u.status === 'ACTIVE' ? 'success' : 'neutral'}>{u.status}</Pill>
                ),
              },
              {
                key: 'hours',
                header: 'Std hrs/wk',
                align: 'right',
                render: (u) => (
                  <HoursEditor user={u} field="standardHoursPerWeek" onSaved={() => void load()} />
                ),
              },
              {
                key: 'target',
                header: 'Billable target',
                align: 'right',
                render: (u) => (
                  <HoursEditor
                    user={u}
                    field="billableTargetHoursPerMonth"
                    onSaved={() => void load()}
                  />
                ),
              },
            ]}
            rows={users}
            rowKey={(u) => u.id}
            empty="No staff yet."
          />
        )}
      </Card>
    </div>
  );
}

function HoursEditor({
  user,
  field,
  onSaved,
}: {
  user: User;
  field: 'standardHoursPerWeek' | 'billableTargetHoursPerMonth';
  onSaved: () => void;
}): JSX.Element {
  const initial =
    field === 'standardHoursPerWeek'
      ? user.standardHoursPerWeek == null
        ? ''
        : String(user.standardHoursPerWeek)
      : user.billableTargetHoursPerMonth == null
        ? ''
        : String(user.billableTargetHoursPerMonth);
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    if (v === initial) return;
    const num = v === '' ? null : Number(v);
    if (num != null && !Number.isFinite(num)) return;
    setBusy(true);
    try {
      await api(`/api/staff/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: num }),
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <input
      type="number"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => void save()}
      placeholder={field === 'billableTargetHoursPerMonth' ? 'inherit' : '40'}
      disabled={busy}
      style={{
        width: 70,
        padding: '4px 6px',
        textAlign: 'right',
        background: tokens.color.surface,
        color: tokens.color.text,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.sm,
        fontSize: 12,
      }}
    />
  );
}
