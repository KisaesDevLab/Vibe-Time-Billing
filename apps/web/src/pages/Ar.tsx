// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useMemo, useState } from 'react';

import { Button, Card, ColumnFilter, Combobox, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { selectRows, useColumnView } from '../lib/column-view';
import { useClientPage } from '../lib/use-paged-list';
import { TableSearch } from '../components/TableSearch';

type Bucket = '0-30' | '31-60' | '61-90' | '90+';

interface ClientAging {
  clientId: string;
  clientName: string;
  buckets: Record<Bucket, number>;
  total: number;
  avgDaysPastDue: number;
}

interface ArResponse {
  asOf: string;
  totals: Record<Bucket, number>;
  clients?: ClientAging[];
  rows?: ClientAging[];
  total?: number;
  page?: number;
  pageSize?: number;
}

interface AppUser {
  id: string;
  fullName: string;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const buckets: Bucket[] = ['0-30', '31-60', '61-90', '90+'];

export function ArPage(): JSX.Element {
  const [data, setData] = useState<ArResponse | null>(null);
  const [clients, setClients] = useState<ClientAging[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Server-side filter with no per-column equivalent.
  const [clientOwnerId, setClientOwnerId] = useState('');

  // Per-column filter + sort (client-side over the loaded clients).
  const view = useColumnView('vibe.ar.view', { sortCol: 'total', sortDir: 'desc' });

  // 0054 — selected clients for bulk statement actions.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [stmtNote, setStmtNote] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
      // No `page`/`pageSize` → all clients returned; filter + sort run
      // client-side. The response exposes the array as both `clients`
      // and `rows`.
      const r = await api<ArResponse>(`/api/staff/ar/aging?${params.toString()}`);
      setData(r);
      setClients(r.clients ?? r.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
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

  // 0054 — Download a single client's statement PDF. Builds a session-
  // authed fetch (the api client returns text/json by default; we use
  // raw fetch with the cookie/credentials path).
  async function downloadOneStatement(clientId: string, clientName: string): Promise<void> {
    setStmtNote(null);
    try {
      const r = await fetch(`/api/staff/statements/clients/${clientId}?accept=pdf`, {
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statement-${clientName.replace(/[^a-z0-9-]+/gi, '_')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'statement_download_failed');
    }
  }

  async function bulkGenerate(): Promise<void> {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setStmtNote(null);
    try {
      // Need CSRF cookie for the POST; api-client manages that. Use
      // fetch + read the cookie-derived token from a sibling call.
      const csrf = document.cookie
        .split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('__vibe_app_csrf='));
      const csrfToken = csrf ? decodeURIComponent(csrf.split('=')[1] ?? '') : '';
      const r = await fetch('/api/staff/statements/bulk-generate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ clientIds: Array.from(selected) }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `status ${r.status}`);
      }
      const generated = r.headers.get('X-Generated-Count') ?? '0';
      const skipped = r.headers.get('X-Skipped-Count') ?? '0';
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `statements-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setStmtNote(
        `Generated ${generated} statement${generated === '1' ? '' : 's'}.${Number(skipped) > 0 ? ` Skipped ${skipped} (no outstanding balance or unknown client).` : ''}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk_generate_failed');
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkEmail(): Promise<void> {
    if (selected.size === 0) return;
    if (!confirm(`Email statements to ${selected.size} client${selected.size === 1 ? '' : 's'}?`))
      return;
    setBulkBusy(true);
    setStmtNote(null);
    try {
      const r = await api<{
        sent: Array<{ clientId: string }>;
        skipped: Array<{ clientId: string; reason: string }>;
      }>('/api/staff/statements/bulk-email', {
        method: 'POST',
        body: JSON.stringify({ clientIds: Array.from(selected) }),
      });
      setStmtNote(
        `Emailed ${r.sent.length} statement${r.sent.length === 1 ? '' : 's'}.${
          r.skipped.length > 0
            ? ` Skipped ${r.skipped.length}: ${r.skipped
                .slice(0, 3)
                .map((s) => s.reason)
                .join(', ')}${r.skipped.length > 3 ? '…' : ''}.`
            : ''
        }`,
      );
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'bulk_email_failed');
    } finally {
      setBulkBusy(false);
    }
  }
  // Distinct client values for the Client column dropdown.
  const clientValues = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of clients) map.set(c.clientId, c.clientName);
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [clients]);

  const visible = useMemo(
    () =>
      selectRows(clients, view, {
        searchText: (c) => `${c.clientName}`,
        filters: { client: (c) => c.clientId },
        sortValues: {
          client: (c) => c.clientName,
          b0: (c) => c.buckets['0-30'],
          b1: (c) => c.buckets['31-60'],
          b2: (c) => c.buckets['61-90'],
          b3: (c) => c.buckets['90+'],
          total: (c) => c.total,
          avg: (c) => c.avgDaysPastDue,
        },
      }),
    [clients, view],
  );

  const { paged, pagination } = useClientPage(visible);

  function toggleAll(): void {
    if (selected.size === visible.length) setSelected(new Set());
    else setSelected(new Set(visible.map((c) => c.clientId)));
  }

  if (loading && !data) return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  if (error || !data) return <p style={{ color: tokens.color.danger }}>{error}</p>;

  const grand =
    data.totals['0-30'] + data.totals['31-60'] + data.totals['61-90'] + data.totals['90+'];
  const total = clients.length;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <a href="/payments/new" style={{ textDecoration: 'none' }}>
          <Button>+ Receive payment</Button>
        </a>
      </div>
      <Card title={`AR aging as of ${data.asOf}`} action={<Pill tone="accent">live</Pill>}>
        <div style={{ display: 'flex', gap: 32, fontSize: 13 }}>
          {buckets.map((b) => (
            <div key={b}>
              <div
                style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}
              >
                {b} days
              </div>
              <strong
                style={{
                  fontSize: 18,
                  color: b === '90+' ? tokens.color.danger : tokens.color.text,
                }}
              >
                {formatCents(data.totals[b])}
              </strong>
            </div>
          ))}
          <div>
            <div
              style={{ fontSize: 11, color: tokens.color.textMuted, textTransform: 'uppercase' }}
            >
              Total
            </div>
            <strong style={{ fontSize: 18 }}>{formatCents(grand)}</strong>
          </div>
        </div>
      </Card>
      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>By client</span>
            {clients.length > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {visible.length === clients.length
                  ? `${total.toLocaleString()} client${total === 1 ? '' : 's'}`
                  : `${visible.length} of ${total.toLocaleString()}`}
              </span>
            )}
          </span>
        }
        action={
          view.anyFilterActive ? (
            <button
              type="button"
              onClick={view.clearFilters}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.color.accent,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          ) : undefined
        }
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr',
            gap: 8,
            marginBottom: 12,
            maxWidth: 280,
          }}
        >
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
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={view} placeholder="Search clients…" />
        </div>
        {/* 0054 — bulk action bar appears when rows are selected. */}
        {selected.size > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '8px 12px',
              marginBottom: 8,
              borderRadius: tokens.radius.md,
              background: tokens.color.accentMuted,
            }}
          >
            <span style={{ fontSize: 13, color: tokens.color.accent }}>
              {selected.size} client{selected.size === 1 ? '' : 's'} selected
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Button size="sm" disabled={bulkBusy} onClick={() => void bulkGenerate()}>
                {bulkBusy ? 'Working…' : 'Generate statements (PDF)'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={bulkBusy}
                onClick={() => void bulkEmail()}
              >
                Email statements
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </span>
          </div>
        )}
        {stmtNote && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{stmtNote}</p>
        )}
        <Table<ClientAging>
          columns={[
            {
              key: 'sel',
              header: (
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={selected.size > 0 && selected.size === visible.length}
                  onChange={toggleAll}
                />
              ) as unknown as string,
              render: (c) => (
                <input
                  type="checkbox"
                  checked={selected.has(c.clientId)}
                  aria-label={`Select ${c.clientName}`}
                  onChange={() => toggleRow(c.clientId)}
                />
              ),
            },
            {
              key: 'name',
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
              render: (c) => c.clientName,
            },
            {
              key: '0-30',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  0-30{' '}
                  <ColumnFilter
                    ariaLabel="Sort by 0-30 days"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('b0')}
                    onApply={(_, dir) => view.apply('b0', new Set(), dir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right' as const,
              render: (c) => formatCents(c.buckets['0-30']),
            },
            {
              key: '31-60',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  31-60{' '}
                  <ColumnFilter
                    ariaLabel="Sort by 31-60 days"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('b1')}
                    onApply={(_, dir) => view.apply('b1', new Set(), dir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right' as const,
              render: (c) => formatCents(c.buckets['31-60']),
            },
            {
              key: '61-90',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  61-90{' '}
                  <ColumnFilter
                    ariaLabel="Sort by 61-90 days"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('b2')}
                    onApply={(_, dir) => view.apply('b2', new Set(), dir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right' as const,
              render: (c) => formatCents(c.buckets['61-90']),
            },
            {
              key: '90+',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  90+{' '}
                  <ColumnFilter
                    ariaLabel="Sort by 90+ days"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('b3')}
                    onApply={(_, dir) => view.apply('b3', new Set(), dir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right' as const,
              render: (c) => formatCents(c.buckets['90+']),
            },
            {
              key: 'total',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Total{' '}
                  <ColumnFilter
                    ariaLabel="Sort by total"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('total')}
                    onApply={(_, dir) => view.apply('total', new Set(), dir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right',
              render: (c) => <strong>{formatCents(c.total)}</strong>,
            },
            {
              key: 'avg',
              header: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Avg days past due{' '}
                  <ColumnFilter
                    ariaLabel="Sort by average days past due"
                    values={[]}
                    selected={new Set()}
                    searchable={false}
                    sort={view.sortFor('avg')}
                    onApply={(_, dir) => view.apply('avg', new Set(), dir)}
                  />
                </span>
              ) as unknown as string,
              align: 'right',
              render: (c) => <span>{c.avgDaysPastDue}</span>,
            },
            {
              key: 'stmt',
              header: '',
              align: 'right',
              render: (c) => (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void downloadOneStatement(c.clientId, c.clientName)}
                  title="Download this client's statement of account as a PDF"
                >
                  Statement
                </Button>
              ),
            },
          ]}
          rows={paged}
          pagination={pagination}
          rowKey={(c) => c.clientId}
          empty="No outstanding AR matches the current filters."
        />
      </Card>
    </div>
  );
}
