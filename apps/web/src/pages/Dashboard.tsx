// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button, Card, Combobox, Pill, ResponsiveGrid, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAuth } from '../auth-context';
import { MyCalendarPanel } from './calendar/MyCalendarPanel';
import { TimeSuggestionBanner } from './calendar/TimeSuggestionBanner';

interface RealizationItem {
  key: string;
  label: string | null;
  originalValueCents: number;
  adjustedValueCents: number;
  realizationPct: number;
}

interface FirmSummary {
  activeClients: number;
  activeEngagements: number;
  arOutstandingCents: number;
  collectionsLast30DaysCents: number;
  wipHours: number;
  wipAmountCents: number;
}

interface MyEngagement {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  workflowState: string;
  priority: string;
  engagementTypeId: string | null;
  dueDate: string | null;
}

interface EngagementType {
  id: string;
  name: string;
}

type MySortCol = 'name' | 'client' | 'workflowState' | 'priority' | 'dueDate';

const formatPct = (p: number): string => `${(p * 100).toFixed(1)}%`;
const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

// 0050 — realization date presets.
type Preset = 'MTD' | 'QTD' | 'YTD' | 'LAST30' | 'CUSTOM';
const PRESETS: { id: Preset; label: string }[] = [
  { id: 'MTD', label: 'MTD' },
  { id: 'QTD', label: 'QTD' },
  { id: 'YTD', label: 'YTD' },
  { id: 'LAST30', label: 'Last 30' },
  { id: 'CUSTOM', label: 'Custom' },
];

function computeRange(
  preset: Preset,
  custom: { start: string; end: string },
): { start: string; end: string } {
  const today = new Date();
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const todayStr = iso(today);
  if (preset === 'CUSTOM') return custom;
  if (preset === 'LAST30') {
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    return { start: iso(start), end: todayStr };
  }
  if (preset === 'MTD') {
    return { start: iso(new Date(today.getFullYear(), today.getMonth(), 1)), end: todayStr };
  }
  if (preset === 'QTD') {
    const q = Math.floor(today.getMonth() / 3) * 3;
    return { start: iso(new Date(today.getFullYear(), q, 1)), end: todayStr };
  }
  // YTD
  return { start: iso(new Date(today.getFullYear(), 0, 1)), end: todayStr };
}

function daysFromToday(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${iso}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export function DashboardPage(): JSX.Element {
  const { me } = useAuth();
  const [items, setItems] = useState<RealizationItem[]>([]);
  // Realization card: 'mine' = the current staff person's realization;
  // 'service_line' = firm-wide breakdown by service line.
  const [realizMode, setRealizMode] = useState<'mine' | 'service_line'>('mine');
  const [summary, setSummary] = useState<FirmSummary | null>(null);
  const [myEngagements, setMyEngagements] = useState<MyEngagement[]>([]);
  const [engTypes, setEngTypes] = useState<EngagementType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 0050 — date range for realization. Default MTD.
  const [preset, setPreset] = useState<Preset>('MTD');
  const [customRange, setCustomRange] = useState({
    start: new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10),
    end: new Date().toISOString().slice(0, 10),
  });
  const range = useMemo(() => computeRange(preset, customRange), [preset, customRange]);

  // 0051 — My Work filters + sort + pagination (client-side since the
  // set is bounded to "assigned to me" + ACTIVE).
  const [filterClientId, setFilterClientId] = useState('');
  const [filterTypeId, setFilterTypeId] = useState('');
  const [filterState, setFilterState] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ col: MySortCol; dir: 'asc' | 'desc' }>({
    col: 'dueDate',
    dir: 'asc',
  });

  useEffect(() => {
    void (async () => {
      try {
        const params = new URLSearchParams({ start: range.start, end: range.end });
        if (realizMode === 'service_line') {
          params.set('dimension', 'service_line');
        } else {
          params.set('dimension', 'timekeeper');
          // Scope to the logged-in staff person's own realization.
          if (me?.appUserId) params.set('appUserId', me.appUserId);
        }
        const [r, s] = await Promise.all([
          api<{ items: RealizationItem[] }>(`/api/staff/reports/realization?${params}`),
          api<{ summary: FirmSummary | null }>('/api/staff/stats/firm'),
        ]);
        setItems(r.items ?? []);
        setSummary(s.summary);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [range.start, range.end, realizMode, me?.appUserId]);

  useEffect(() => {
    if (!me?.appUserId) return;
    void (async () => {
      try {
        const [r, t] = await Promise.all([
          api<{ items: MyEngagement[] }>(
            `/api/staff/engagements?assigneeUserId=${me.appUserId}&status=ACTIVE&limit=5000`,
          ),
          api<{ items: EngagementType[] }>('/api/staff/taxonomy/engagement-types').catch(() => ({
            items: [],
          })),
        ]);
        setMyEngagements(r.items ?? []);
        setEngTypes(t.items ?? []);
      } catch {
        // Non-fatal.
      }
    })();
  }, [me?.appUserId]);

  // Reset to page 1 when any filter / sort changes.
  useEffect(() => {
    setPage(1);
  }, [filterClientId, filterTypeId, filterState, filterPriority, sort]);

  // Distinct workflow states + clients drawn from the loaded set so
  // the filter dropdowns don't show empty options.
  const stateOpts = useMemo(() => {
    const set = new Set(myEngagements.map((e) => e.workflowState));
    return Array.from(set).map((s) => ({ value: s, label: s }));
  }, [myEngagements]);
  const clientOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of myEngagements) m.set(e.clientId, e.clientName);
    return Array.from(m.entries())
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [myEngagements]);

  const filtered = useMemo(() => {
    let arr = myEngagements;
    if (filterClientId) arr = arr.filter((e) => e.clientId === filterClientId);
    if (filterTypeId) arr = arr.filter((e) => e.engagementTypeId === filterTypeId);
    if (filterState) arr = arr.filter((e) => e.workflowState === filterState);
    if (filterPriority) arr = arr.filter((e) => e.priority === filterPriority);
    const sign = sort.dir === 'asc' ? 1 : -1;
    return [...arr].sort((a, b) => {
      switch (sort.col) {
        case 'name':
          return sign * a.name.localeCompare(b.name);
        case 'client':
          return sign * a.clientName.localeCompare(b.clientName);
        case 'workflowState':
          return sign * a.workflowState.localeCompare(b.workflowState);
        case 'priority':
          return sign * a.priority.localeCompare(b.priority);
        case 'dueDate': {
          // Empty due dates sort last regardless of direction so they
          // don't clutter the top of the list.
          const ad = a.dueDate ?? '';
          const bd = b.dueDate ?? '';
          if (!ad && !bd) return 0;
          if (!ad) return 1;
          if (!bd) return -1;
          return sign * ad.localeCompare(bd);
        }
      }
    });
  }, [myEngagements, filterClientId, filterTypeId, filterState, filterPriority, sort]);

  const totalMy = filtered.length;
  const pageCount = Math.max(1, Math.ceil(totalMy / pageSize));
  const pageRows = useMemo(
    () => filtered.slice((page - 1) * pageSize, page * pageSize),
    [filtered, page, pageSize],
  );

  function toggleSort(col: MySortCol): void {
    setSort((p) =>
      p.col === col ? { col, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' },
    );
  }
  const sortIcon = (col: MySortCol): string =>
    sort.col === col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <AlertsCallout />
      <TimeSuggestionBanner />
      {summary && (
        <Card title="Firm at a glance">
          <ResponsiveGrid min={160}>
            <Stat label="Active clients" value={summary.activeClients.toLocaleString()} />
            <Stat label="Active engagements" value={summary.activeEngagements.toLocaleString()} />
            <Stat label="WIP" value={formatCents(summary.wipAmountCents)} />
            <Stat label="AR outstanding" value={formatCents(summary.arOutstandingCents)} />
            <Stat
              label="Collections (30d)"
              value={formatCents(summary.collectionsLast30DaysCents)}
            />
          </ResponsiveGrid>
        </Card>
      )}

      <InboxCard />

      {/* Realization sits directly under "Needs attention" (InboxCard). */}
      <Card
        title={realizMode === 'service_line' ? 'Realization by service line' : 'My realization'}
        action={
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                display: 'inline-flex',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              <Button
                size="sm"
                variant={realizMode === 'mine' ? 'secondary' : 'ghost'}
                onClick={() => setRealizMode('mine')}
                aria-pressed={realizMode === 'mine'}
              >
                Mine
              </Button>
              <Button
                size="sm"
                variant={realizMode === 'service_line' ? 'secondary' : 'ghost'}
                onClick={() => setRealizMode('service_line')}
                aria-pressed={realizMode === 'service_line'}
              >
                Service line
              </Button>
            </span>
            <span
              style={{
                display: 'inline-flex',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
              }}
            >
              {PRESETS.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={preset === p.id ? 'secondary' : 'ghost'}
                  onClick={() => setPreset(p.id)}
                  aria-pressed={preset === p.id}
                >
                  {p.label}
                </Button>
              ))}
            </span>
            <Pill tone="accent">live</Pill>
          </span>
        }
      >
        {preset === 'CUSTOM' && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, fontSize: 13 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              From
              <input
                type="date"
                value={customRange.start}
                onChange={(e) => setCustomRange((r) => ({ ...r, start: e.target.value }))}
                style={inputStyle}
              />
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              To
              <input
                type="date"
                value={customRange.end}
                onChange={(e) => setCustomRange((r) => ({ ...r, end: e.target.value }))}
                style={inputStyle}
              />
            </label>
          </div>
        )}
        <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: '0 0 8px 0' }}>
          {range.start} → {range.end}
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
        {loading ? (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
        ) : (
          <Table
            columns={[
              {
                key: 'name',
                header: realizMode === 'service_line' ? 'Service line' : 'Timekeeper',
                render: (r) => r.label ?? r.key,
              },
              {
                key: 'wip',
                header: 'Standard WIP',
                align: 'right',
                render: (r) => formatCents(r.originalValueCents),
              },
              {
                key: 'adj',
                header: 'After adjustments',
                align: 'right',
                render: (r) => formatCents(r.adjustedValueCents),
              },
              {
                key: 'pct',
                header: 'Realization',
                align: 'right',
                render: (r) => formatPct(r.realizationPct),
              },
            ]}
            rows={items}
            rowKey={(r) => r.key}
            empty="No adjustment data yet. Create a billing batch and a write-down to populate."
          />
        )}
      </Card>

      <MyCalendarPanel />

      <UpcomingBookingsPanel />

      {/* 0050 — My active engagements card (now below realization). */}
      <Card
        title={`My active engagements — ${totalMy.toLocaleString()}`}
        action={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <a href="/engagements" style={{ color: tokens.color.accent }}>
              View all →
            </a>
            <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              Page size
              <select
                aria-label="Page size"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                style={{ padding: '4px 6px' }}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
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
        {/* 0051 — per-column filter row. Each picker re-filters the
            already-loaded set; no server roundtrip per click. */}
        <ResponsiveGrid min={170} gap={8} style={{ marginBottom: 12 }}>
          <Combobox
            ariaLabel="Filter client"
            clearable
            value={filterClientId}
            onChange={setFilterClientId}
            options={clientOpts}
            placeholder="Any client"
            size="sm"
          />
          <Combobox
            ariaLabel="Filter type"
            clearable
            value={filterTypeId}
            onChange={setFilterTypeId}
            options={engTypes.map((t) => ({ value: t.id, label: t.name }))}
            placeholder="Any type"
            size="sm"
          />
          <Combobox
            ariaLabel="Filter status"
            clearable
            value={filterState}
            onChange={setFilterState}
            options={stateOpts}
            placeholder="Any status"
            size="sm"
          />
          <Combobox
            ariaLabel="Filter priority"
            clearable
            value={filterPriority}
            onChange={setFilterPriority}
            options={[
              { value: 'LOW', label: 'Low' },
              { value: 'MEDIUM', label: 'Medium' },
              { value: 'HIGH', label: 'High' },
              { value: 'URGENT', label: 'Urgent' },
            ]}
            placeholder="Any priority"
            size="sm"
          />
        </ResponsiveGrid>
        {pageRows.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            {myEngagements.length === 0
              ? 'You have no active engagements assigned. Ask a partner to assign you, or open the engagements list to claim work.'
              : 'No engagements match the current filters.'}
          </p>
        ) : (
          <Table<MyEngagement>
            columns={[
              {
                key: 'name',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('name')}>
                    Engagement{sortIcon('name')}
                  </button>
                ) as unknown as string,
                mobile: 'title',
                render: (r) => <a href={`/engagements/${r.id}`}>{r.name}</a>,
              },
              {
                key: 'client',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('client')}>
                    Client{sortIcon('client')}
                  </button>
                ) as unknown as string,
                mobile: 'meta',
                render: (r) => <a href={`/clients/${r.clientId}`}>{r.clientName}</a>,
              },
              {
                key: 'state',
                header: (
                  <button
                    type="button"
                    style={headerBtn}
                    onClick={() => toggleSort('workflowState')}
                  >
                    Status{sortIcon('workflowState')}
                  </button>
                ) as unknown as string,
                mobile: 'badge',
                render: (r) => <Pill>{r.workflowState}</Pill>,
              },
              {
                key: 'pri',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('priority')}>
                    Priority{sortIcon('priority')}
                  </button>
                ) as unknown as string,
                mobile: 'badge',
                render: (r) => <Pill>{r.priority}</Pill>,
              },
              {
                key: 'due',
                header: (
                  <button type="button" style={headerBtn} onClick={() => toggleSort('dueDate')}>
                    Due{sortIcon('dueDate')}
                  </button>
                ) as unknown as string,
                mobile: 'field',
                mobileLabel: 'Due',
                render: (r) => {
                  if (!r.dueDate) return <span style={{ color: tokens.color.textMuted }}>—</span>;
                  const days = daysFromToday(r.dueDate);
                  const tone =
                    days == null
                      ? 'neutral'
                      : days < 0
                        ? 'danger'
                        : days <= 7
                          ? 'warning'
                          : 'neutral';
                  const label =
                    days == null
                      ? ''
                      : days < 0
                        ? `${Math.abs(days)}d overdue`
                        : days === 0
                          ? 'today'
                          : `in ${days}d`;
                  return (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <span>{r.dueDate}</span>
                      <Pill tone={tone}>{label}</Pill>
                    </span>
                  );
                },
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                mobile: 'actions',
                render: (r) => (
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => (window.location.href = `/engagements/${r.id}`)}
                    >
                      Open
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        (window.location.href = `/time?clientId=${r.clientId}&engagementId=${r.id}`)
                      }
                    >
                      Time
                    </Button>
                  </span>
                ),
              },
            ]}
            rows={pageRows}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      <Card title="What's next">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: tokens.color.textMuted }}>
          <li>Set up service lines and work codes under Admin → Taxonomy</li>
          <li>Invite staff and assign roles under Admin → Users</li>
          <li>Create clients and engagements</li>
          <li>Track time, then generate pre-bills and adjustments</li>
        </ul>
      </Card>
    </div>
  );
}

interface InboxCounts {
  clientMsg: number;
  teamMsg: number;
  requests: number;
  intake: number;
  approvals: number;
  bookingRequests: number;
}

function InboxCard(): JSX.Element {
  const navigate = useNavigate();
  const [counts, setCounts] = useState<InboxCounts | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      void api<InboxCounts>('/api/staff/stats/inbox-counts')
        .then((r) => alive && setCounts(r))
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const items: { key: keyof InboxCounts; label: string; href: string }[] = [
    { key: 'clientMsg', label: 'Client Msg', href: '/messages' },
    { key: 'teamMsg', label: 'Team Msg', href: '/messages?tab=team' },
    { key: 'requests', label: 'Requests', href: '/requests' },
    { key: 'intake', label: 'Intake', href: '/intake' },
    { key: 'approvals', label: 'Approvals', href: '/approvals' },
    { key: 'bookingRequests', label: 'Booking', href: '/appointments#requests' },
  ];

  return (
    <Card title="Needs attention">
      <ResponsiveGrid min={120}>
        {items.map((it) => {
          const value = counts ? counts[it.key] : 0;
          const has = value > 0;
          return (
            <button
              key={it.key}
              type="button"
              onClick={() => navigate(it.href)}
              title={`Go to ${it.label}`}
              style={{
                display: 'grid',
                gap: 4,
                justifyItems: 'start',
                textAlign: 'left',
                padding: 12,
                border: `1px solid ${has ? tokens.color.accent : tokens.color.border}`,
                borderRadius: tokens.radius.md,
                background: has ? tokens.color.accentMuted : 'transparent',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 700,
                  lineHeight: 1,
                  color: has ? tokens.color.accent : tokens.color.textMuted,
                }}
              >
                {counts ? value : '—'}
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: has ? tokens.color.accent : tokens.color.text,
                  fontWeight: has ? 600 : 400,
                }}
              >
                {it.label}
              </span>
            </button>
          );
        })}
      </ResponsiveGrid>
    </Card>
  );
}

function AlertsCallout(): JSX.Element {
  const [count, setCount] = useState<number>(0);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: unknown[] }>('/api/staff/audit/alerts');
        setCount(r.items.length);
      } catch {
        // ignore
      }
    })();
  }, []);
  if (count === 0) return <></>;
  return (
    <Card title="Alerts">
      <p style={{ fontSize: 13, margin: 0 }}>
        <Pill tone="warning">{count}</Pill>{' '}
        <a href="/alerts" style={{ color: tokens.color.accent }}>
          worker alerts need attention
        </a>{' '}
        — scope creep, aged WIP, audit anomalies, engagement rollovers.
      </p>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
};

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

// BK-8 — upcoming TB-originated appointments for the next 7 days.
interface UpcomingAppt {
  id: string;
  title: string;
  startsAt: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  clientName: string | null;
  typeName: string | null;
  location: string | null;
  locationDetail: string | null;
}

function UpcomingBookingsPanel(): JSX.Element {
  const [rows, setRows] = useState<UpcomingAppt[]>([]);
  useEffect(() => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    void api<{ items: UpcomingAppt[] }>(
      `/api/staff/appointments?status=SCHEDULED&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
      .then((r) => setRows(r.items ?? []))
      .catch(() => setRows([]));
  }, []);
  return (
    <Card
      title="Upcoming bookings (7 days)"
      action={
        <Button
          size="sm"
          onClick={() => {
            window.location.href = '/appointments#book';
          }}
        >
          Book appointment
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          No appointments in the next 7 days.
        </p>
      ) : (
        <Table<UpcomingAppt>
          columns={[
            {
              key: 'when',
              header: 'When',
              mobile: 'meta',
              render: (r) => new Date(r.startsAt).toLocaleString(),
            },
            {
              key: 'client',
              header: 'Client',
              mobile: 'title',
              render: (r) => r.clientName ?? '—',
            },
            { key: 'type', header: 'Type', mobile: 'field', render: (r) => r.typeName ?? r.title },
            {
              key: 'location',
              header: 'Location',
              mobile: 'field',
              render: (r) => r.locationDetail || r.location || '—',
            },
          ]}
          rows={rows}
          rowKey={(r) => r.id}
          empty="None."
        />
      )}
    </Card>
  );
}
