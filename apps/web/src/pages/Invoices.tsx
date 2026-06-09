// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useMemo, useState } from 'react';

import { Button, Card, ColumnFilter, Combobox, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { selectRows, useColumnView } from '../lib/column-view';

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

const STATUS_VALUES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SENT', label: 'Sent' },
  { value: 'PARTIALLY_PAID', label: 'Partially paid' },
  { value: 'PAID', label: 'Paid' },
  { value: 'OVERDUE', label: 'Overdue' },
  { value: 'VOIDED', label: 'Voided' },
];

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
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Server-side filters with no per-column equivalent.
  const [clientOwnerId, setClientOwnerId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Per-column filter + sort (client-side over the loaded rows).
  const view = useColumnView('vibe.invoices.view', { sortCol: 'issued', sortDir: 'desc' });

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (clientOwnerId) params.set('clientOwnerId', clientOwnerId);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      // No `page`/`pageSize` → legacy non-paginated mode (returns up to
      // 500 rows under `items`); filter + sort run client-side.
      const r = await api<{ items: Invoice[] }>(`/api/staff/invoices?${params.toString()}`);
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientOwnerId, startDate, endDate]);

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

  // Distinct client values for the Client column dropdown.
  const clientValues = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of items) map.set(i.clientId, i.clientName);
    return Array.from(map.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  const visible = useMemo(
    () =>
      selectRows(items, view, {
        filters: {
          client: (i) => i.clientId,
          status: (i) => i.status,
        },
        sortValues: {
          invoice: (i) => i.invoiceNumber,
          client: (i) => i.clientName,
          issued: (i) => i.issueDate,
          due: (i) => i.dueDate ?? '',
          total: (i) => i.totalCents,
          paid: (i) => i.paidCents,
          status: (i) => i.status,
        },
      }),
    [items, view],
  );

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1400 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <a href="/payments/new" style={{ textDecoration: 'none' }}>
          <Button>+ Receive payment</Button>
        </a>
      </div>
      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Invoices</span>
            {items.length > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {visible.length === items.length
                  ? `${items.length} invoice${items.length === 1 ? '' : 's'}`
                  : `${visible.length} of ${items.length}`}
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
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8,
            marginBottom: 12,
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
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            aria-label="Issued from"
            style={dateInputStyle}
          />
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Invoice{' '}
                    <ColumnFilter
                      ariaLabel="Sort by invoice number"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('invoice')}
                      onApply={(_, dir) => view.apply('invoice', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (i) => i.invoiceNumber,
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
                render: (i) => i.clientName,
              },
              {
                key: 'issue',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Issued{' '}
                    <ColumnFilter
                      ariaLabel="Sort by issued date"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('issued')}
                      onApply={(_, dir) => view.apply('issued', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (i) => i.issueDate,
              },
              {
                key: 'due',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Due{' '}
                    <ColumnFilter
                      ariaLabel="Sort by due date"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('due')}
                      onApply={(_, dir) => view.apply('due', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (i) => i.dueDate,
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
                render: (i) => formatCents(i.totalCents),
              },
              {
                key: 'paid',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Paid{' '}
                    <ColumnFilter
                      ariaLabel="Sort by paid"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('paid')}
                      onApply={(_, dir) => view.apply('paid', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                align: 'right',
                render: (i) => formatCents(i.paidCents),
              },
              {
                key: 'status',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Status{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort status"
                      values={STATUS_VALUES}
                      selected={view.filterFor('status')}
                      searchable={false}
                      sort={view.sortFor('status')}
                      onApply={(sel, dir) => view.apply('status', sel, dir)}
                    />
                  </span>
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
            rows={visible}
            rowKey={(i) => i.id}
            empty="No invoices match the current filters."
          />
        )}
      </Card>
    </div>
  );
}

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
