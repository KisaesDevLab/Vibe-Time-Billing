// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, ColumnFilter, Combobox, Pill, Table, tokens, type SortDir } from '@vibe/ui';

import { api } from '../api-client';
import { TableSearch } from '../components/TableSearch';
import { selectRows, useColumnView } from '../lib/column-view';

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

  // clientOwnerId remains server-side (no column equivalent)
  const [clientOwnerId, setClientOwnerId] = useState('');
  const [users, setUsers] = useState<AppUser[]>([]);

  // selection for bulk Bill action — operates over visible rows
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [billing, setBilling] = useState(false);

  const view = useColumnView('vibe.wip.view');

  // Distinct client/engagement value lists built from loaded rows
  const clientValues = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.clientId, r.clientName);
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const engValues = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.engagementId, r.engagementName);
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);

  const visible = useMemo(
    () =>
      selectRows(rows, view, {
        filters: {
          client: (r) => r.clientId,
          eng: (r) => r.engagementId,
        },
        sortValues: {
          client: (r) => r.clientName,
          eng: (r) => r.engagementName,
          hours: (r) => r.hours,
          value: (r) => r.amountCents,
          entries: (r) => r.entryCount,
          oldest: (r) => r.oldestDate ?? '',
        },
        searchText: (r) => `${r.clientName} ${r.engagementName}`,
      }),
    [rows, view],
  );

  async function load(): Promise<void> {
    try {
      const params = new URLSearchParams();
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
  }, [clientOwnerId]);

  useEffect(() => {
    void (async () => {
      try {
        const u = await api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({
          users: [],
        }));
        setUsers(u.users ?? []);
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
    if (selected.size === visible.length) setSelected(new Set());
    else setSelected(new Set(visible.map((r) => r.engagementId)));
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
      const list = visible
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
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginBottom: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ width: 220 }}>
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
          {view.anyFilterActive && (
            <button
              type="button"
              onClick={view.clearFilters}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.color.accent,
                fontSize: 12,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              Clear column filters
            </button>
          )}
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={view} placeholder="Search WIP…" />
        </div>
        <Table<WipRow>
          columns={[
            {
              key: 'sel',
              header: (
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={visible.length > 0 && selected.size === visible.length}
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
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Client{' '}
                  <ColumnFilter
                    ariaLabel="Filter / sort client"
                    values={clientValues}
                    selected={view.filterFor('client')}
                    sort={view.sortFor('client')}
                    onApply={(sel, dir) => view.apply('client', sel, dir)}
                  />
                </span>
              ) as unknown as string,
              render: (r) => <a href={`/clients/${r.clientId}`}>{r.clientName}</a>,
            },
            {
              key: 'eng',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Engagement{' '}
                  <ColumnFilter
                    ariaLabel="Filter / sort engagement"
                    values={engValues}
                    selected={view.filterFor('eng')}
                    sort={view.sortFor('eng')}
                    onApply={(sel, dir) => view.apply('eng', sel, dir)}
                  />
                </span>
              ) as unknown as string,
              render: (r) => <a href={`/engagements/${r.engagementId}`}>{r.engagementName}</a>,
            },
            {
              key: 'hours',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Hours{' '}
                  <ColumnFilter
                    ariaLabel="Sort by hours"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('hours')}
                    onApply={(_, dir) => view.apply('hours', new Set(), dir as SortDir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right',
              render: (r) => r.hours.toFixed(2),
            },
            {
              key: 'amount',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Value{' '}
                  <ColumnFilter
                    ariaLabel="Sort by value"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('value')}
                    onApply={(_, dir) => view.apply('value', new Set(), dir as SortDir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right',
              render: (r) => formatCents(r.amountCents),
            },
            {
              key: 'count',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Entries{' '}
                  <ColumnFilter
                    ariaLabel="Sort by entries"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('entries')}
                    onApply={(_, dir) => view.apply('entries', new Set(), dir as SortDir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right',
              render: (r) => String(r.entryCount),
            },
            {
              key: 'age',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Oldest{' '}
                  <ColumnFilter
                    ariaLabel="Sort by oldest"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('oldest')}
                    onApply={(_, dir) => view.apply('oldest', new Set(), dir as SortDir)}
                  />
                </span>
              ) as unknown as string,
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
          rows={visible}
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
