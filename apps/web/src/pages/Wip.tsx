// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Combobox, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface WipRow {
  engagementId: string;
  engagementName: string;
  clientId: string;
  clientName: string;
  clientOwnerId: string | null;
  hours: number;
  amountCents: number;
  entryCount: number;
  oldestDate: string | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

interface ClientLite {
  id: string;
  name: string;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

function daysSince(date: string | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - Date.parse(date)) / 86_400_000);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStartIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

export function WipDashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const [rows, setRows] = useState<WipRow[]>([]);
  const [asOf, setAsOf] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // 0050 — filters
  const [clientId, setClientId] = useState('');
  const [engagementId, setEngagementId] = useState('');
  const [clientOwnerId, setClientOwnerId] = useState('');
  const [users, setUsers] = useState<AppUser[]>([]);
  const [clientOptions, setClientOptions] = useState<ClientLite[]>([]);

  // 0050 — selection for bulk Bill action
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [billing, setBilling] = useState(false);

  async function load(): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (clientId) params.set('clientId', clientId);
      if (engagementId) params.set('engagementId', engagementId);
      if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
      const r = await api<{ asOf: string; items: WipRow[] }>(
        `/api/staff/billing-batches/wip-dashboard?${params.toString()}`,
      );
      setAsOf(r.asOf);
      setRows(r.items ?? []);
      setSelected(new Set()); // clear selection on reload
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, engagementId, clientOwnerId]);

  useEffect(() => {
    void (async () => {
      try {
        const [u, c] = await Promise.all([
          api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
          api<{ items: ClientLite[] }>('/api/staff/clients').catch(() => ({ items: [] })),
        ]);
        setUsers(u.users ?? []);
        setClientOptions(c.items ?? []);
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  function toggleRow(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll(): void {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.engagementId)));
  }

  function billOne(r: WipRow): void {
    // Per-row Bill — pre-fill the billing-batch create flow with the
    // client + engagement and a period that spans the WIP age.
    const start = r.oldestDate ?? monthStartIso();
    const end = todayIso();
    navigate(
      `/billing?engagementId=${r.engagementId}&clientId=${r.clientId}&periodStart=${start}&periodEnd=${end}`,
    );
  }

  async function billSelected(): Promise<void> {
    if (selected.size === 0) return;
    const periodStart = prompt('Period start (YYYY-MM-DD):', monthStartIso());
    if (!periodStart) return;
    const periodEnd = prompt('Period end (YYYY-MM-DD):', todayIso());
    if (!periodEnd) return;
    setBilling(true);
    try {
      const list = rows
        .filter((r) => selected.has(r.engagementId))
        .map((r) => ({ engagementId: r.engagementId, periodStart, periodEnd }));
      const result = await api<{ created: number; ids: string[] }>(
        '/api/staff/billing-batches/bulk',
        { method: 'POST', body: JSON.stringify({ engagements: list }) },
      );
      alert(`Created ${result.created} billing batch${result.created === 1 ? '' : 'es'}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk_failed');
    } finally {
      setBilling(false);
    }
  }

  const totalCents = rows.reduce((a, r) => a + r.amountCents, 0);
  const totalHours = rows.reduce((a, r) => a + r.hours, 0);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1300 }}>
      <Card title={`Firm-wide WIP · ${asOf || 'loading'}`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Stat label="Engagements with WIP" value={String(rows.length)} />
          <Stat label="Unbilled hours" value={totalHours.toFixed(2)} />
          <Stat label="Unbilled value" value={formatCents(totalCents)} />
        </div>
      </Card>

      <Card
        title="By engagement (largest first)"
        action={
          selected.size > 0 ? (
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: tokens.color.accent }}>
                {selected.size} selected
              </span>
              <Button size="sm" disabled={billing} onClick={() => void billSelected()}>
                {billing ? 'Creating…' : `Bill ${selected.size} selected`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Cancel
              </Button>
            </span>
          ) : null
        }
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <Combobox
            ariaLabel="Client"
            clearable
            value={clientId}
            onChange={setClientId}
            options={clientOptions.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Any client"
            size="sm"
          />
          <Combobox
            ariaLabel="Engagement"
            clearable
            value={engagementId}
            onChange={setEngagementId}
            options={rows.map((r) => ({
              value: r.engagementId,
              label: `${r.clientName} · ${r.engagementName}`,
            }))}
            placeholder="Any engagement"
            size="sm"
          />
          <Combobox
            ariaLabel="Client owner"
            clearable
            value={clientOwnerId}
            onChange={setClientOwnerId}
            options={users.map((u) => ({ value: u.id, label: u.fullName }))}
            placeholder="Any owner"
            size="sm"
          />
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<WipRow>
          columns={[
            {
              key: 'sel',
              header: (
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={selected.size > 0 && selected.size === rows.length}
                  onChange={toggleAll}
                />
              ) as unknown as string,
              render: (r) => (
                <input
                  type="checkbox"
                  checked={selected.has(r.engagementId)}
                  aria-label={`Select ${r.engagementName}`}
                  onChange={() => toggleRow(r.engagementId)}
                />
              ),
            },
            {
              key: 'client',
              header: 'Client',
              render: (r) => <a href={`/clients/${r.clientId}`}>{r.clientName}</a>,
            },
            {
              key: 'eng',
              header: 'Engagement',
              render: (r) => <a href={`/engagements/${r.engagementId}`}>{r.engagementName}</a>,
            },
            {
              key: 'hours',
              header: 'Hours',
              align: 'right',
              render: (r) => r.hours.toFixed(2),
            },
            {
              key: 'amount',
              header: 'Value',
              align: 'right',
              render: (r) => formatCents(r.amountCents),
            },
            {
              key: 'count',
              header: 'Entries',
              align: 'right',
              render: (r) => String(r.entryCount),
            },
            {
              key: 'age',
              header: 'Oldest',
              render: (r) => {
                const d = daysSince(r.oldestDate);
                if (d == null) return '—';
                return <Pill tone={d > 60 ? 'danger' : d > 30 ? 'warning' : 'neutral'}>{d}d</Pill>;
              },
            },
            {
              key: 'bill',
              header: '',
              align: 'right',
              render: (r) => (
                <Button size="sm" onClick={() => billOne(r)}>
                  Bill
                </Button>
              ),
            },
          ]}
          rows={rows}
          rowKey={(r) => r.engagementId}
          empty="No unbilled time entries match the current filters."
        />
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
