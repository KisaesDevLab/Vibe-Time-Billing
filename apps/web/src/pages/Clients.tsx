// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Client {
  id: string;
  name: string;
  status: string;
  termsDays: number;
  invoiceConsolidationPreference: 'CONSOLIDATED' | 'SEPARATE';
}

interface AppUser {
  id: string;
  fullName: string;
}

export function ClientsPage(): JSX.Element {
  const [clients, setClients] = useState<Client[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [partnerInChargeId, setPartner] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ items: Client[] }>(
        `/api/staff/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      );
      setClients(r.items ?? []);
      const u = await api<{ users: AppUser[] }>('/api/staff/admin/users');
      setUsers(u.users ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await api('/api/staff/clients', {
        method: 'POST',
        body: JSON.stringify({ name, partnerInChargeId }),
      });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Search">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Client name" />
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <Card title="New client">
        <form
          onSubmit={create}
          style={{
            display: 'grid',
            gap: 12,
            gridTemplateColumns: '2fr 2fr auto',
            alignItems: 'end',
          }}
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label style={{ display: 'block', fontFamily: tokens.font.body }}>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
              Partner in charge
            </div>
            <select
              value={partnerInChargeId}
              onChange={(e) => setPartner(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '10px 12px',
                background: tokens.color.surface,
                color: tokens.color.text,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 14,
              }}
            >
              <option value="">— select —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit">Create</Button>
        </form>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      <Card title="Clients">
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<Client>
            columns={[
              {
                key: 'name',
                header: 'Name',
                render: (c) => <a href={`/clients/${c.id}`}>{c.name}</a>,
              },
              {
                key: 'terms',
                header: 'Terms (days)',
                align: 'right',
                render: (c) => String(c.termsDays),
              },
              {
                key: 'consol',
                header: 'Consolidation',
                render: (c) => <Pill>{c.invoiceConsolidationPreference}</Pill>,
              },
              {
                key: 'status',
                header: 'Status',
                render: (c) => (
                  <Pill tone={c.status === 'ACTIVE' ? 'success' : 'neutral'}>{c.status}</Pill>
                ),
              },
            ]}
            rows={clients}
            rowKey={(c) => c.id}
            empty="No clients yet."
          />
        )}
      </Card>
    </div>
  );
}
