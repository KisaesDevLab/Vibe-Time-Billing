// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Button, Card, Combobox, Input, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Eng {
  id: string;
  name: string;
  clientId: string;
  clientName: string | null;
  engagementTypeId: string | null;
  partnerId: string | null;
  // Joined from engagement_type → service_line by the list endpoint.
  serviceLineId: string | null;
  serviceLineName: string | null;
  serviceLineCategory: string | null;
}

interface Summary {
  engagementId: string;
  costCents: number;
  billedCents: number;
  paidCents: number;
  marginCents: number;
  marginPct: number | null;
}

interface AppUser {
  id: string;
  fullName: string;
}
interface ClientLite {
  id: string;
  name: string;
  partnerInChargeId: string | null;
}
interface EngType {
  id: string;
  name: string;
}
interface ServiceLine {
  id: string;
  name: string;
  category: string;
}

type SortCol = 'name' | 'cost' | 'billed' | 'paid' | 'margin' | 'pct';

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function ProfitabilityPage(): JSX.Element {
  // Window + revenue basis persist in the URL (shareable, and saved
  // reports "Open" links land here with their params intact).
  const [search, setSearch] = useSearchParams();
  const basis = search.get('basis') === 'cash' ? 'cash' : 'accrual';
  const start = search.get('start') ?? '';
  const end = search.get('end') ?? '';
  function setUrlParam(name: string, value: string): void {
    const next = new URLSearchParams(search);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearch(next, { replace: true });
  }
  const [rows, setRows] = useState<Array<{ eng: Eng; summary: Summary | null }>>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [clients, setClients] = useState<ClientLite[]>([]);
  const [types, setTypes] = useState<EngType[]>([]);
  const [serviceLinesList, setServiceLinesList] = useState<ServiceLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [clientId, setClientId] = useState('');
  const [engagementTypeId, setEngagementTypeId] = useState('');
  const [serviceLineId, setServiceLineId] = useState('');
  const [clientOwnerId, setClientOwnerId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ col: SortCol; dir: 'asc' | 'desc' }>({
    col: 'margin',
    dir: 'desc',
  });

  async function loadAll(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      // One aggregate query instead of N per-engagement calls (was up to 500
      // requests on load). The engagement list supplies names + filter
      // metadata; /reports/profitability supplies cost/billed/paid per
      // engagement — firm-scoped, DRAFT/VOIDED excluded, ARCHIVED time
      // excluded, and consolidated invoices split across engagements.
      const qs = new URLSearchParams({ basis });
      if (start) qs.set('start', start);
      if (end) qs.set('end', end);
      const [engRes, profRes] = await Promise.all([
        api<{ items: Eng[] }>('/api/staff/engagements?status=ACTIVE&limit=500'),
        api<{ items: Summary[] }>(`/api/staff/reports/profitability?${qs.toString()}`),
      ]);
      const byEng = new Map((profRes.items ?? []).map((s) => [s.engagementId, s]));
      // Margin comes straight from the endpoint, which follows the selected
      // basis: accrual = billed − cost, cash = collected-in-window − cost.
      const results = (engRes.items ?? []).map((e) => ({
        eng: e,
        summary: byEng.get(e.id) ?? null,
      }));
      setRows(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basis, start, end]);

  useEffect(() => {
    void (async () => {
      try {
        const [u, c, t, sl] = await Promise.all([
          api<{ users: AppUser[] }>('/api/staff/admin/users').catch(() => ({ users: [] })),
          api<{ items: ClientLite[] }>('/api/staff/clients').catch(() => ({ items: [] })),
          api<{ items: EngType[] }>('/api/staff/taxonomy/engagement-types').catch(() => ({
            items: [],
          })),
          api<{ items: ServiceLine[] }>('/api/staff/taxonomy/service-lines').catch(() => ({
            items: [],
          })),
        ]);
        setUsers(u.users ?? []);
        setClients(c.items ?? []);
        setTypes(t.items ?? []);
        setServiceLinesList(sl.items ?? []);
      } catch {
        // Non-fatal.
      }
    })();
  }, []);

  const clientOwnerByClient = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of clients) m.set(c.id, c.partnerInChargeId);
    return m;
  }, [clients]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!r.summary) return false;
      if (r.summary.billedCents === 0 && r.summary.costCents === 0 && r.summary.paidCents === 0)
        return false;
      if (clientId && r.eng.clientId !== clientId) return false;
      if (engagementTypeId && r.eng.engagementTypeId !== engagementTypeId) return false;
      if (serviceLineId && r.eng.serviceLineId !== serviceLineId) return false;
      if (clientOwnerId && clientOwnerByClient.get(r.eng.clientId) !== clientOwnerId) return false;
      return true;
    });
  }, [rows, clientId, engagementTypeId, serviceLineId, clientOwnerId, clientOwnerByClient]);

  const sorted = useMemo(() => {
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const sa = a.summary!;
      const sb = b.summary!;
      switch (sort.col) {
        case 'name':
          return sign * a.eng.name.localeCompare(b.eng.name);
        case 'cost':
          return sign * (sa.costCents - sb.costCents);
        case 'billed':
          return sign * (sa.billedCents - sb.billedCents);
        case 'paid':
          return sign * (sa.paidCents - sb.paidCents);
        case 'margin':
          return sign * (sa.marginCents - sb.marginCents);
        case 'pct': {
          const pa = sa.marginPct ?? -Infinity;
          const pb = sb.marginPct ?? -Infinity;
          return sign * (pa - pb);
        }
      }
    });
  }, [filtered, sort]);

  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const visible = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  function toggleSort(col: SortCol): void {
    setSort((p) =>
      p.col === col ? { col, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    );
    setPage(1);
  }
  const sortIcon = (col: SortCol): string =>
    sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1300 }}>
      <Card
        title="Engagement profitability"
        action={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <Button size="sm" variant="secondary" onClick={() => void loadAll()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </Button>
            <span style={{ color: tokens.color.textMuted, fontSize: 13 }}>
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
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Cost is derived from each time entry&apos;s effective timekeeper cost rate.{' '}
          {basis === 'cash'
            ? 'Cash basis: revenue is money actually collected in the window (payment receipt date), and margin = collected − cost.'
            : 'Accrual basis: revenue is the amount billed (invoice issue date), and margin = billed − cost.'}
        </p>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'end',
            flexWrap: 'wrap',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Basis</span>
            <span style={{ display: 'inline-flex', gap: 4 }}>
              {(['accrual', 'cash'] as const).map((b) => (
                <Button
                  key={b}
                  size="sm"
                  variant={basis === b ? 'primary' : 'secondary'}
                  onClick={() => setUrlParam('basis', b === 'accrual' ? '' : b)}
                >
                  {b === 'accrual' ? 'Accrual' : 'Cash'}
                </Button>
              ))}
            </span>
          </div>
          <Input
            label="Start"
            type="date"
            value={start}
            onChange={(e) => setUrlParam('start', e.target.value)}
          />
          <Input
            label="End"
            type="date"
            value={end}
            onChange={(e) => setUrlParam('end', e.target.value)}
          />
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr 1fr 120px',
            gap: 8,
            marginBottom: 12,
          }}
        >
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
            ariaLabel="Engagement type"
            clearable
            value={engagementTypeId}
            onChange={(v) => {
              setEngagementTypeId(v);
              setPage(1);
            }}
            options={types.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="Any type"
            size="sm"
          />
          <Combobox
            ariaLabel="Service line"
            clearable
            value={serviceLineId}
            onChange={(v) => {
              setServiceLineId(v);
              setPage(1);
            }}
            options={serviceLinesList.map((sl) => ({
              value: sl.id,
              label: `${sl.name} (${sl.category})`,
            }))}
            placeholder="Any service line"
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
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<{ eng: Eng; summary: Summary | null }>
          columns={[
            {
              key: 'eng',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('name')}>
                  Engagement{sortIcon('name')}
                </button>
              ) as unknown as string,
              render: (r) => (
                <a href={`/engagements/${r.eng.id}`}>
                  {r.eng.clientName ? `${r.eng.clientName} · ` : ''}
                  {r.eng.name}
                </a>
              ),
            },
            {
              key: 'cost',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('cost')}>
                  Cost{sortIcon('cost')}
                </button>
              ) as unknown as string,
              align: 'right',
              render: (r) => (r.summary ? formatCents(r.summary.costCents) : '—'),
            },
            {
              key: 'billed',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('billed')}>
                  Billed{sortIcon('billed')}
                </button>
              ) as unknown as string,
              align: 'right',
              render: (r) => (r.summary ? formatCents(r.summary.billedCents) : '—'),
            },
            {
              key: 'paid',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('paid')}>
                  Paid{sortIcon('paid')}
                </button>
              ) as unknown as string,
              align: 'right',
              render: (r) => (r.summary ? formatCents(r.summary.paidCents) : '—'),
            },
            {
              key: 'margin',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('margin')}>
                  Margin{sortIcon('margin')}
                </button>
              ) as unknown as string,
              align: 'right',
              render: (r) => (r.summary ? formatCents(r.summary.marginCents) : '—'),
            },
            {
              key: 'pct',
              header: (
                <button type="button" style={headerBtn} onClick={() => toggleSort('pct')}>
                  Margin %{sortIcon('pct')}
                </button>
              ) as unknown as string,
              align: 'right',
              render: (r) => {
                const p = r.summary?.marginPct;
                if (p == null) return '—';
                return (
                  <Pill tone={p >= 30 ? 'success' : p >= 10 ? 'warning' : 'danger'}>
                    {p.toFixed(1)}%
                  </Pill>
                );
              },
            },
          ]}
          rows={visible}
          rowKey={(r) => r.eng.id}
          empty="No engagement profitability data matches the current filters."
        />
        <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
          Showing {visible.length} of {total} engagements with cost or revenue.
        </p>
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
