// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { CreateClientWizard } from './clients/CreateClientWizard';

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
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [r, u, p] = await Promise.all([
        api<{ items: Client[] }>(`/api/staff/clients${q ? `?q=${encodeURIComponent(q)}` : ''}`),
        api<{ users: AppUser[] }>('/api/staff/admin/users'),
        api<{ items: { clientId: string }[] }>('/api/staff/clients/pins').catch(() => ({
          items: [],
        })),
      ]);
      const pins = new Set((p.items ?? []).map((x) => x.clientId));
      setPinnedIds(pins);
      // Sort pinned to top, then alphabetical.
      const sorted = [...(r.items ?? [])].sort((a, b) => {
        const pa = pins.has(a.id) ? 0 : 1;
        const pb = pins.has(b.id) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name);
      });
      setClients(sorted);
      setUsers(u.users ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function togglePin(clientId: string): Promise<void> {
    const isPinned = pinnedIds.has(clientId);
    try {
      if (isPinned) {
        await api(`/api/staff/clients/pins/${clientId}`, { method: 'DELETE' });
      } else {
        await api('/api/staff/clients/pins', {
          method: 'POST',
          body: JSON.stringify({ clientId }),
        });
      }
      await load();
    } catch {
      // Non-fatal — refresh on next reload.
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card
        title="Clients"
        action={<Button onClick={() => setWizardOpen(true)}>+ New client</Button>}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </Card>

      <CreateClientWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={() => void load()}
        users={users}
      />

      <Card title="Results">
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<Client>
            columns={[
              {
                key: 'pin',
                header: '',
                render: (c) => (
                  <button
                    type="button"
                    onClick={() => void togglePin(c.id)}
                    aria-label={pinnedIds.has(c.id) ? 'Unpin client' : 'Pin client'}
                    title={
                      pinnedIds.has(c.id) ? 'Unpin (remove from top of list)' : 'Pin to top of list'
                    }
                    style={{
                      fontSize: 16,
                      lineHeight: 1,
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: pinnedIds.has(c.id) ? tokens.color.accent : tokens.color.textMuted,
                      padding: 0,
                    }}
                  >
                    {pinnedIds.has(c.id) ? '★' : '☆'}
                  </button>
                ),
              },
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
