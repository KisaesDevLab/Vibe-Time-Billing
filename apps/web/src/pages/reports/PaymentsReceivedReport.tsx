/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: Elastic-2.0
//
// Payments Received report. Filters by date range, office, and
// payment method; renders sortable rows with a summary card up top.
// Backed by GET /api/staff/reports/payments-received. CSV export
// uses the same row set the user is currently looking at.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, Card, Pill, Stat, Table, type TableColumn, tokens } from '@vibe/ui';
import { useClientPage } from '../../lib/use-paged-list';

import { api } from '../../api-client';
import { formatCents } from '../../lib/money';

interface RowResp {
  id: string;
  paymentDate: string;
  clientId: string;
  clientName: string;
  officeId: string | null;
  officeName: string | null;
  paymentMethod: string;
  provider: string;
  mode: string;
  reference: string | null;
  totalCents: number;
  status: string;
}

interface Report {
  from: string;
  to: string;
  rows: RowResp[];
  summary: { count: number; totalCents: number };
  byMethod: Array<{ method: string; count: number; totalCents: number }>;
  byOffice: Array<{
    officeId: string | null;
    name: string;
    count: number;
    totalCents: number;
  }>;
  methodOptions: string[];
}

interface OfficeOption {
  id: string;
  name: string;
  isDefault: boolean;
}

type SortKey = 'date' | 'client' | 'office' | 'method' | 'amount';
type SortDir = 'asc' | 'desc';

function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  return {
    from: monthStart.toISOString().slice(0, 10),
    to: today.toISOString().slice(0, 10),
  };
}

export function PaymentsReceivedReportPage(): JSX.Element {
  const init = defaultRange();
  const [from, setFrom] = useState(init.from);
  const [to, setTo] = useState(init.to);
  const [officeId, setOfficeId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('date');
  const [dir, setDir] = useState<SortDir>('desc');

  const [data, setData] = useState<Report | null>(null);
  const [offices, setOffices] = useState<OfficeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from, to, sortBy, dir });
      if (officeId) qs.set('officeId', officeId);
      if (paymentMethod) qs.set('paymentMethod', paymentMethod);
      const r = await api<Report>(`/api/staff/reports/payments-received?${qs.toString()}`);
      setData(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [from, to, sortBy, dir, officeId, paymentMethod]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        const o = await api<{ offices: OfficeOption[] }>('/api/staff/admin/offices').catch(() => ({
          offices: [],
        }));
        setOffices(o.offices ?? []);
      } catch {
        // Non-fatal: office filter stays empty.
      }
    })();
  }, []);

  function toggleSort(k: SortKey): void {
    if (sortBy === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortBy(k);
      setDir('asc');
    }
  }

  function downloadCsv(): void {
    if (!data) return;
    const header = [
      'Date',
      'Client',
      'Office',
      'Method',
      'Provider',
      'Mode',
      'Reference',
      'Amount (USD)',
      'Status',
    ];
    const lines: string[] = [header.join(',')];
    for (const r of data.rows) {
      const cells = [
        r.paymentDate,
        r.clientName,
        r.officeName ?? '',
        r.paymentMethod,
        r.provider,
        r.mode,
        r.reference ?? '',
        (r.totalCents / 100).toFixed(2),
        r.status,
      ].map(csvCell);
      lines.push(cells.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payments-received-${data.from}-to-${data.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalCents = useMemo(() => data?.summary.totalCents ?? 0, [data]);

  const { paged, pagination } = useClientPage(data?.rows ?? []);

  const detailColumns: TableColumn<RowResp>[] = [
    {
      key: 'date',
      header: (
        <SortableHeader label="Date" k="date" sortBy={sortBy} dir={dir} onSort={toggleSort} />
      ),
      render: (r) => new Date(r.paymentDate).toLocaleDateString(),
    },
    {
      key: 'client',
      header: (
        <SortableHeader label="Client" k="client" sortBy={sortBy} dir={dir} onSort={toggleSort} />
      ),
      render: (r) => (
        <Link
          to={`/clients/${r.clientId}`}
          style={{ color: tokens.color.accent, textDecoration: 'none' }}
        >
          {r.clientName}
        </Link>
      ),
    },
    {
      key: 'office',
      header: (
        <SortableHeader label="Office" k="office" sortBy={sortBy} dir={dir} onSort={toggleSort} />
      ),
      render: (r) => r.officeName ?? '—',
    },
    {
      key: 'method',
      header: (
        <SortableHeader label="Method" k="method" sortBy={sortBy} dir={dir} onSort={toggleSort} />
      ),
      render: (r) => r.paymentMethod,
    },
    { key: 'reference', header: 'Reference', render: (r) => r.reference ?? '—' },
    {
      key: 'amount',
      align: 'right',
      header: (
        <SortableHeader label="Amount" k="amount" sortBy={sortBy} dir={dir} onSort={toggleSort} />
      ),
      render: (r) => formatCents(r.totalCents),
    },
    {
      key: 'mode',
      header: 'Mode',
      render: (r) => <Pill tone={r.mode === 'CHARGE' ? 'accent' : 'neutral'}>{r.mode}</Pill>,
    },
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1280 }}>
      <Link
        to="/reports"
        style={{ color: tokens.color.accent, fontSize: 12, textDecoration: 'none' }}
      >
        ← All reports
      </Link>

      <Card
        title="Payments Received"
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={downloadCsv}
            disabled={!data || data.rows.length === 0}
          >
            ↓ CSV
          </Button>
        }
      >
        {/* Filter bar — two rows give each control a comfortable width
            instead of squeezing five lanes across the card. Date range
            on the top row, scope filters on the second. */}
        <div
          style={{
            display: 'grid',
            gap: 12,
            padding: 12,
            marginBottom: 12,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.surface,
          }}
        >
          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'minmax(180px, 1fr) minmax(180px, 1fr) auto',
              alignItems: 'end',
            }}
          >
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={lblStyle()}>From</label>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                style={inputStyle()}
              />
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={lblStyle()}>To</label>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={inputStyle()}
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                const d = defaultRange();
                setFrom(d.from);
                setTo(d.to);
                setOfficeId('');
                setPaymentMethod('');
              }}
            >
              Reset filters
            </Button>
          </div>
          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: 'minmax(200px, 1fr) minmax(200px, 1fr)',
              alignItems: 'end',
            }}
          >
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={lblStyle()}>Office</label>
              <select
                value={officeId}
                onChange={(e) => setOfficeId(e.target.value)}
                style={inputStyle()}
              >
                <option value="">Any office</option>
                {offices.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.isDefault ? `${o.name} (default)` : o.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={lblStyle()}>Payment method</label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                style={inputStyle()}
              >
                <option value="">Any method</option>
                {(data?.methodOptions ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
        )}

        {/* Summary strip */}
        {data && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
              marginBottom: 12,
            }}
          >
            <Stat label="Payments received" value={String(data.summary.count)} />
            <Stat label="Total" value={formatCents(totalCents)} />
            <Stat label="Date range" value={`${data.from} → ${data.to}`} />
          </div>
        )}

        {/* Breakdown cards */}
        {data && (data.byMethod.length > 0 || data.byOffice.length > 0) && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: tokens.space.md,
              marginBottom: 12,
            }}
          >
            <BreakdownTable
              title="By method"
              rows={data.byMethod.map((m) => ({
                name: m.method,
                count: m.count,
                total: m.totalCents,
              }))}
            />
            <BreakdownTable
              title="By office"
              rows={data.byOffice.map((o) => ({
                name: o.name,
                count: o.count,
                total: o.totalCents,
              }))}
            />
          </div>
        )}

        {/* Rows table */}
        {loading ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : !data || data.rows.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            No payments received in this window.
          </p>
        ) : (
          <Table<RowResp>
            columns={detailColumns}
            rows={paged}
            rowKey={(r) => r.id}
            pagination={pagination}
          />
        )}
      </Card>
    </div>
  );
}

function BreakdownTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ name: string; count: number; total: number }>;
}): JSX.Element {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>—</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} style={{ borderBottom: `1px solid ${tokens.color.border}` }}>
                <td style={{ padding: '4px 6px' }}>{r.name}</td>
                <td
                  style={{ padding: '4px 6px', textAlign: 'right', color: tokens.color.textMuted }}
                >
                  {r.count}
                </td>
                <td
                  style={{
                    padding: '4px 6px',
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatCents(r.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function SortableHeader({
  label,
  k,
  sortBy,
  dir,
  onSort,
}: {
  label: string;
  k: SortKey;
  sortBy: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
}): JSX.Element {
  const active = sortBy === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      style={{
        background: 'none',
        border: 'none',
        color: active ? tokens.color.accent : tokens.color.textMuted,
        font: 'inherit',
        fontWeight: 600,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        cursor: 'pointer',
        padding: 0,
      }}
    >
      {label}
      {active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </button>
  );
}

function lblStyle(): React.CSSProperties {
  return { fontSize: 11, color: tokens.color.textMuted };
}
function inputStyle(): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontSize: 13,
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.bg,
    color: tokens.color.text,
    boxSizing: 'border-box',
    width: '100%',
  };
}
function csvCell(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
