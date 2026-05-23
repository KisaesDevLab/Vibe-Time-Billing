// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

type Bucket = '0-30' | '31-60' | '61-90' | '90+';
type SortCol = 'clientName' | 'b1' | 'b2' | 'b3' | 'b4' | 'total';

interface ClientAging {
  clientId: string;
  clientName: string;
  buckets: Record<Bucket, number>;
  total: number;
}

interface ArResponse {
  asOf: string;
  totals: Record<Bucket, number>;
  clients: ClientAging[];
  total?: number;
  page?: number;
  pageSize?: number;
}

interface AppUser {
  id: string;
  fullName: string;
}
interface ClientLite {
  id: string;
  name: string;
}

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const buckets: Bucket[] = ['0-30', '31-60', '61-90', '90+'];

export function ArPage(): JSX.Element {
  const [data, setData] = useState<ArResponse | null>(null);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [clientOpts, setClientOpts] = useState<ClientLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [clientOwnerId, setClientOwnerId] = useState('');
  const [clientId, setClientId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ col: SortCol; dir: 'asc' | 'desc' }>({
    col: 'total',
    dir: 'desc',
  });

  // 0054 — selected clients for bulk statement actions.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [stmtNote, setStmtNote] = useState<string | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
      if (clientId) params.set('clientId', clientId);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      params.set('sort', sort.col);
      params.set('dir', sort.dir);
      const r = await api<ArResponse>(`/api/staff/ar/aging?${params.toString()}`);
      setData(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientOwnerId, clientId, page, pageSize, sort]);

  useEffect(() => {
    void (async () => {
      try {
        const [u, c] = await Promise.all([
          api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
          api<{ items: ClientLite[] }>('/api/staff/clients').catch(() => ({ items: [] })),
        ]);
        setUsers(u.users ?? []);
        setClientOpts(c.items ?? []);
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  function toggleSort(col: SortCol): void {
    setSort((p) =>
      p.col === col ? { col, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    );
    setPage(1);
  }

  function toggleRow(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleAll(): void {
    if (!data) return;
    if (selected.size === data.clients.length) setSelected(new Set());
    else setSelected(new Set(data.clients.map((c) => c.clientId)));
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
  const sortIcon = (col: SortCol): string =>
    sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  if (loading && !data) return <p style={{ color: tokens.color.textMuted }}>Loading…</p>;
  if (error || !data) return <p style={{ color: tokens.color.danger }}>{error}</p>;

  const grand =
    data.totals['0-30'] + data.totals['31-60'] + data.totals['61-90'] + data.totals['90+'];
  const total = data.total ?? data.clients.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

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
        title={`By client — ${total.toLocaleString()}`}
        action={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 120px',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <Combobox
            ariaLabel="Client owner"
            clearable
            value={clientOwnerId}
            onChange={(v) => {
              setClientOwnerId(v);
              setPage(1);
            }}
            options={users.map((u) => ({ value: u.id, label: u.fullName }))}
            placeholder="Any owner"
            size="sm"
          />
          <Combobox
            ariaLabel="Client"
            clearable
            value={clientId}
            onChange={(v) => {
              setClientId(v);
              setPage(1);
            }}
            options={clientOpts.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Any client"
            size="sm"
          />
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            aria-label="Page size"
            style={{ padding: '4px 6px' }}
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
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
                  checked={selected.size > 0 && selected.size === data.clients.length}
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
                <button type="button" style={headerBtn} onClick={() => toggleSort('clientName')}>
                  Client{sortIcon('clientName')}
                </button>
              ) as unknown as string,
              render: (c) => c.clientName,
            },
            {
              key: '0-30',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('b1')}>
                  0-30{sortIcon('b1')}
                </button>
              ) as unknown as string,
              align: 'right' as const,
              render: (c) => formatCents(c.buckets['0-30']),
            },
            {
              key: '31-60',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('b2')}>
                  31-60{sortIcon('b2')}
                </button>
              ) as unknown as string,
              align: 'right' as const,
              render: (c) => formatCents(c.buckets['31-60']),
            },
            {
              key: '61-90',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('b3')}>
                  61-90{sortIcon('b3')}
                </button>
              ) as unknown as string,
              align: 'right' as const,
              render: (c) => formatCents(c.buckets['61-90']),
            },
            {
              key: '90+',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('b4')}>
                  90+{sortIcon('b4')}
                </button>
              ) as unknown as string,
              align: 'right' as const,
              render: (c) => formatCents(c.buckets['90+']),
            },
            {
              key: 'total',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('total')}>
                  Total{sortIcon('total')}
                </button>
              ) as unknown as string,
              align: 'right',
              render: (c) => <strong>{formatCents(c.total)}</strong>,
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
          rows={data.clients}
          rowKey={(c) => c.clientId}
          empty="No outstanding AR matches the current filters."
        />
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
