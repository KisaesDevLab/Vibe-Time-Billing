// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Invoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  clientOwnerId: string | null;
  issueDate: string;
  dueDate: string;
  totalCents: number;
  paidCents: number;
  status: 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOIDED';
  firstViewedAt: string | null;
  lastReminderAt: string | null;
}

interface AppUser {
  id: string;
  fullName: string;
}

interface ClientLite {
  id: string;
  name: string;
}

type SortCol =
  | 'invoiceNumber'
  | 'clientName'
  | 'issueDate'
  | 'dueDate'
  | 'total'
  | 'paid'
  | 'status';

const formatCents = (c: number): string =>
  `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const tone = (s: Invoice['status']) =>
  s === 'PAID'
    ? 'success'
    : s === 'OVERDUE'
      ? 'danger'
      : s === 'PARTIALLY_PAID'
        ? 'warning'
        : 'accent';

function hoursSince(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - Date.parse(iso)) / (1000 * 60 * 60);
}

export function InvoicesPage(): JSX.Element {
  const [items, setItems] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientOwnerId, setClientOwnerId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Pagination + sort
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ col: SortCol; dir: 'asc' | 'desc' }>({
    col: 'issueDate',
    dir: 'desc',
  });

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (clientId) params.set('clientId', clientId);
      if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      params.set('sort', sort.col);
      params.set('dir', sort.dir);
      const r = await api<{ rows: Invoice[]; total: number }>(
        `/api/staff/invoices?${params.toString()}`,
      );
      setItems(r.rows ?? []);
      setTotal(r.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, clientId, clientOwnerId, startDate, endDate, page, pageSize, sort]);

  useEffect(() => {
    void (async () => {
      try {
        const [u, c] = await Promise.all([
          api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
          api<{ items: ClientLite[] }>('/api/staff/clients').catch(() => ({ items: [] })),
        ]);
        setUsers(u.users ?? []);
        setClients(c.items ?? []);
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  async function send(id: string): Promise<void> {
    await api(`/api/staff/invoices/${id}/send`, { method: 'POST' });
    await load();
  }

  async function remind(id: string): Promise<void> {
    try {
      await api(`/api/staff/invoices/${id}/remind`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reminder_failed');
    }
  }

  function toggleSort(col: SortCol): void {
    setSort((p) =>
      p.col === col ? { col, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    );
    setPage(1);
  }
  const sortIcon = (col: SortCol): string =>
    sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <a href="/payments/new" style={{ textDecoration: 'none' }}>
          <Button>+ Receive payment</Button>
        </a>
      </div>
      <Card
        title={`Invoices — ${total.toLocaleString()}`}
        action={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              Page size
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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: 8,
            marginBottom: 12,
          }}
        >
          <Combobox
            ariaLabel="Status"
            clearable
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(1);
            }}
            options={[
              { value: 'DRAFT', label: 'Draft' },
              { value: 'SENT', label: 'Sent' },
              { value: 'PARTIALLY_PAID', label: 'Partially paid' },
              { value: 'PAID', label: 'Paid' },
              { value: 'OVERDUE', label: 'Overdue' },
              { value: 'VOIDED', label: 'Voided' },
            ]}
            placeholder="Any status"
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
            options={clients.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Any client"
            size="sm"
          />
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
          <input
            type="date"
            value={startDate}
            onChange={(e) => {
              setStartDate(e.target.value);
              setPage(1);
            }}
            aria-label="Issued from"
            style={dateInputStyle}
          />
          <input
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
              setPage(1);
            }}
            aria-label="Issued to"
            style={dateInputStyle}
          />
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table<Invoice>
            columns={[
              {
                key: 'num',
                header: (
                  <button
                    type="button"
                    style={headerBtn}
                    onClick={() => toggleSort('invoiceNumber')}
                  >
                    Invoice{sortIcon('invoiceNumber')}
                  </button>
                ) as unknown as string,
                render: (i) => i.invoiceNumber,
              },
              {
                key: 'client',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('clientName')}>
                    Client{sortIcon('clientName')}
                  </button>
                ) as unknown as string,
                render: (i) => i.clientName,
              },
              {
                key: 'issue',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('issueDate')}>
                    Issued{sortIcon('issueDate')}
                  </button>
                ) as unknown as string,
                render: (i) => i.issueDate,
              },
              {
                key: 'due',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('dueDate')}>
                    Due{sortIcon('dueDate')}
                  </button>
                ) as unknown as string,
                render: (i) => i.dueDate,
              },
              {
                key: 'total',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('total')}>
                    Total{sortIcon('total')}
                  </button>
                ) as unknown as string,
                align: 'right',
                render: (i) => formatCents(i.totalCents),
              },
              {
                key: 'paid',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('paid')}>
                    Paid{sortIcon('paid')}
                  </button>
                ) as unknown as string,
                align: 'right',
                render: (i) => formatCents(i.paidCents),
              },
              {
                key: 'status',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('status')}>
                    Status{sortIcon('status')}
                  </button>
                ) as unknown as string,
                render: (i) => <Pill tone={tone(i.status)}>{i.status}</Pill>,
              },
              {
                key: 'viewed',
                header: 'Viewed',
                render: (i) =>
                  i.firstViewedAt ? (
                    <span style={{ color: tokens.color.success, fontSize: 12 }}>
                      {new Date(i.firstViewedAt).toLocaleDateString()}
                    </span>
                  ) : (
                    <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>not yet</span>
                  ),
              },
              {
                key: 'actions',
                header: '',
                render: (i) => {
                  const hours = hoursSince(i.lastReminderAt);
                  const cooldown = hours !== null && hours < 24;
                  const canRemind =
                    i.status !== 'PAID' && i.status !== 'VOIDED' && i.status !== 'DRAFT';
                  return (
                    <span style={{ display: 'flex', gap: 6 }}>
                      {i.status === 'DRAFT' && (
                        <Button size="sm" onClick={() => void send(i.id)}>
                          Send
                        </Button>
                      )}
                      {canRemind && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={cooldown}
                          title={
                            cooldown
                              ? `Last reminder sent ${hours!.toFixed(1)}h ago — wait until 24h.`
                              : 'Send a reminder email'
                          }
                          onClick={() => void remind(i.id)}
                        >
                          Remind
                        </Button>
                      )}
                      <a href={`/invoices/${i.id}`} style={linkBtn}>
                        Open
                      </a>
                      <a
                        href={`/api/staff/invoices/${i.id}/pdf`}
                        target="_blank"
                        rel="noreferrer"
                        style={linkBtn}
                      >
                        PDF
                      </a>
                    </span>
                  );
                },
              },
            ]}
            rows={items}
            rowKey={(i) => i.id}
            empty="No invoices match the current filters."
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

const dateInputStyle: React.CSSProperties = {
  padding: '6px 8px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
};

const linkBtn: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  background: 'transparent',
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  textDecoration: 'none',
};
