// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useMemo, useState } from 'react';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { CreateClientWizard } from './clients/CreateClientWizard';

interface ClientRow {
  id: string;
  name: string;
  status: string;
  clientType: string;
  externalId: string | null;
  partnerInChargeId: string | null;
  partnerName: string | null;
  termsDays: number;
  invoiceConsolidationPreference: 'CONSOLIDATED' | 'SEPARATE';
  createdAt: string;
  mailingCity: string | null;
  mailingState: string | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

type SortCol = 'name' | 'externalId' | 'clientType' | 'status' | 'partnerName' | 'createdAt';

export function ClientsPage(): JSX.Element {
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // 0050 — filters
  const [clientOwnerId, setClientOwnerId] = useState<string>('');
  const [clientType, setClientType] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  // 0050 — pagination + sort
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<{ col: SortCol; dir: 'asc' | 'desc' }>({
    col: 'name',
    dir: 'asc',
  });

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
      if (clientType) params.set('clientType', clientType);
      if (statusFilter) params.set('status', statusFilter);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      params.set('sort', sort.col);
      params.set('dir', sort.dir);
      // Fetch in parallel; tolerate the secondary calls failing (e.g.
      // a staff user without app_user:read perm) so the client list
      // still renders even if the filter dropdowns are empty.
      const [r, u, p] = await Promise.all([
        api<{ rows: ClientRow[]; total: number }>(`/api/staff/clients?${params.toString()}`),
        api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
        api<{ items: { clientId: string }[] }>('/api/staff/clients/pins').catch(() => ({
          items: [],
        })),
      ]);
      const pins = new Set((p.items ?? []).map((x) => x.clientId));
      setPinnedIds(pins);
      setClients(r.rows ?? []);
      setTotal(r.total ?? 0);
      setUsers(u.users ?? []);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, sort, clientOwnerId, clientType, statusFilter]);

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

  function toggleSort(col: SortCol): void {
    setSort((prev) =>
      prev.col === col ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    );
    setPage(1);
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const sortIcon = (col: SortCol): string =>
    sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  const sortedDisplay = useMemo(() => {
    // Server sorts the data; we only float pinned rows to the top of the
    // current page so the UX is still useful.
    return [...clients].sort((a, b) => {
      const pa = pinnedIds.has(a.id) ? 0 : 1;
      const pb = pinnedIds.has(b.id) ? 0 : 1;
      return pa - pb;
    });
  }, [clients, pinnedIds]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400 }}>
      <Card
        title="Clients"
        action={<Button onClick={() => setWizardOpen(true)}>+ New client</Button>}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void load();
          }}
          style={{ display: 'grid', gap: 8, gridTemplateColumns: '2fr 1fr 1fr 1fr auto' }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, external ID, email, phone, custom fields"
          />
          <Combobox
            ariaLabel="Client owner"
            clearable
            value={clientOwnerId}
            onChange={(v) => {
              setPage(1);
              setClientOwnerId(v);
            }}
            options={users.map((u) => ({ value: u.id, label: u.fullName }))}
            placeholder="Any owner"
            size="sm"
          />
          <Combobox
            ariaLabel="Client type"
            clearable
            value={clientType}
            onChange={(v) => {
              setPage(1);
              setClientType(v);
            }}
            options={[
              { value: 'INDIVIDUAL', label: 'Individual' },
              { value: 'BUSINESS', label: 'Business' },
            ]}
            placeholder="Any type"
            size="sm"
          />
          <Combobox
            ariaLabel="Status"
            clearable
            value={statusFilter}
            onChange={(v) => {
              setPage(1);
              setStatusFilter(v);
            }}
            options={[
              { value: 'ACTIVE', label: 'Active' },
              { value: 'INACTIVE', label: 'Inactive' },
              { value: 'ARCHIVED', label: 'Archived' },
              { value: 'PROSPECT', label: 'Prospect' },
            ]}
            placeholder="Any status"
            size="sm"
          />
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

      <Card
        title={`Results — ${total.toLocaleString()} client${total === 1 ? '' : 's'}`}
        action={
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              Page size
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Page size"
                style={{ padding: '4px 6px', borderRadius: tokens.radius.sm }}
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
              </select>
            </label>
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </Button>
            <span style={{ color: tokens.color.textMuted }}>
              Page {page} / {pageCount}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next →
            </Button>
          </span>
        }
      >
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<ClientRow>
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
                header: (
                  <button type="button" onClick={() => toggleSort('name')} style={headerBtn}>
                    Name{sortIcon('name')}
                  </button>
                ) as unknown as string,
                render: (c) => <a href={`/clients/${c.id}`}>{c.name}</a>,
              },
              {
                key: 'owner',
                header: (
                  <button type="button" onClick={() => toggleSort('partnerName')} style={headerBtn}>
                    Owner{sortIcon('partnerName')}
                  </button>
                ) as unknown as string,
                render: (c) => c.partnerName ?? '—',
              },
              {
                key: 'externalId',
                header: (
                  <button type="button" onClick={() => toggleSort('externalId')} style={headerBtn}>
                    External ID{sortIcon('externalId')}
                  </button>
                ) as unknown as string,
                render: (c) => c.externalId ?? '—',
              },
              {
                key: 'type',
                header: (
                  <button type="button" onClick={() => toggleSort('clientType')} style={headerBtn}>
                    Type{sortIcon('clientType')}
                  </button>
                ) as unknown as string,
                render: (c) => <Pill>{c.clientType}</Pill>,
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
                header: (
                  <button type="button" onClick={() => toggleSort('status')} style={headerBtn}>
                    Status{sortIcon('status')}
                  </button>
                ) as unknown as string,
                render: (c) => (
                  <Pill tone={c.status === 'ACTIVE' ? 'success' : 'neutral'}>{c.status}</Pill>
                ),
              },
            ]}
            rows={sortedDisplay}
            rowKey={(c) => c.id}
            empty="No clients match the current filters."
          />
        )}
      </Card>
    </div>
  );
}

const headerBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  fontFamily: 'inherit',
  fontWeight: 'inherit',
  fontSize: 'inherit',
  color: 'inherit',
  cursor: 'pointer',
};
