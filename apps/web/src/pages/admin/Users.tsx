// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface User {
  id: string;
  email: string;
  fullName: string;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  totpEnrolledAt: string | null;
}

export function UsersPage(): JSX.Element {
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
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<User>
            columns={[
              { key: 'name', header: 'Name', render: (u) => u.fullName },
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
