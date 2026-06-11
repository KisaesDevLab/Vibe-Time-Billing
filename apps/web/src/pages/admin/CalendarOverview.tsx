// SPDX-License-Identifier: Elastic-2.0
//
// CAL-6 — admin all-staff calendar overview: appointment list (filterable),
// CSV export, and a connection-health table.

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Pill, Table, tokens, type TableColumn } from '@vibe/ui';

import { api } from '../../api-client';

interface OverviewRow {
  id: string;
  subject: string | null;
  startAt: string | null;
  staffId: string | null;
  staffName: string | null;
  clientName: string | null;
  matchTier: string | null;
  matchStatus: string | null;
}
interface HealthRow {
  id: string;
  staffName: string | null;
  provider: string;
  providerEmail: string | null;
  enabled: boolean;
  syncError: string | null;
  lastSyncedAt: string | null;
  canWrite: boolean;
}

export function CalendarOverviewPage(): JSX.Element {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [staffFilter, setStaffFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Distinct staff for the filter dropdown, sourced from the loaded rows.
  const [staffOpts, setStaffOpts] = useState<{ id: string; name: string }[]>([]);

  const overviewUrl = useCallback(
    (format?: 'csv') => {
      const p = new URLSearchParams();
      if (staffFilter) p.set('staffId', staffFilter);
      if (from) p.set('from', new Date(from).toISOString());
      if (to) p.set('to', new Date(to + 'T23:59:59').toISOString());
      if (format) p.set('format', format);
      const qs = p.toString();
      return `/api/staff/admin/calendar/overview${qs ? `?${qs}` : ''}`;
    },
    [staffFilter, from, to],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, h] = await Promise.all([
        api<{ items: OverviewRow[] }>(overviewUrl()),
        api<{ connections: HealthRow[] }>('/api/staff/admin/calendar/health'),
      ]);
      const items = o.items ?? [];
      setRows(items);
      setHealth(h.connections ?? []);
      // Build the staff dropdown from the unfiltered result set only, so
      // selecting a staff member doesn't collapse the options to just them.
      if (!staffFilter) {
        const seen = new Map<string, string>();
        for (const r of items) if (r.staffId && r.staffName) seen.set(r.staffId, r.staffName);
        setStaffOpts(
          [...seen.entries()]
            .map(([id, name]) => ({ id, name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      }
    } finally {
      setLoading(false);
    }
  }, [overviewUrl, staffFilter]);
  useEffect(() => {
    void load();
  }, [load]);

  const cols: TableColumn<OverviewRow>[] = [
    {
      key: 'when',
      header: 'When',
      render: (r) => (r.startAt ? new Date(r.startAt).toLocaleString() : '—'),
    },
    { key: 'staff', header: 'Staff', render: (r) => r.staffName ?? '—' },
    { key: 'subject', header: 'Event', render: (r) => r.subject ?? '—' },
    { key: 'client', header: 'Client', render: (r) => r.clientName ?? '—' },
    {
      key: 'tier',
      header: 'Match tier',
      render: (r) =>
        r.matchTier ? (
          <Pill tone="neutral">{r.matchTier}</Pill>
        ) : (
          <span style={{ color: tokens.color.textMuted }}>—</span>
        ),
    },
    {
      key: 'match',
      header: 'Match',
      render: (r) =>
        r.matchStatus ? (
          <Pill tone={r.matchStatus === 'confirmed' ? 'success' : 'warning'}>{r.matchStatus}</Pill>
        ) : (
          '—'
        ),
    },
  ];

  const healthCols: TableColumn<HealthRow>[] = [
    { key: 'staff', header: 'Staff', render: (r) => r.staffName ?? '—' },
    {
      key: 'provider',
      header: 'Provider',
      render: (r) => `${r.provider} (${r.providerEmail ?? '?'})`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.syncError ? (
          <Pill tone="danger">{r.syncError}</Pill>
        ) : r.enabled ? (
          <Pill tone="success">OK</Pill>
        ) : (
          <Pill tone="neutral">Disabled</Pill>
        ),
    },
    {
      key: 'synced',
      header: 'Last synced',
      render: (r) => (r.lastSyncedAt ? new Date(r.lastSyncedAt).toLocaleString() : 'never'),
    },
    {
      key: 'writeback',
      header: 'Write-back',
      render: (r) =>
        r.canWrite ? <Pill tone="success">enabled</Pill> : <Pill tone="warning">read-only</Pill>,
    },
  ];

  const readOnlyCount = health.filter((c) => c.enabled && !c.canWrite).length;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card
        title="All-staff appointments"
        action={
          <Button variant="secondary" onClick={() => window.open(overviewUrl('csv'), '_blank')}>
            Export CSV
          </Button>
        }
      >
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'end', marginBottom: 12 }}
        >
          <label style={labelStyle}>
            Staff
            <select
              value={staffFilter}
              onChange={(e) => setStaffFilter(e.target.value)}
              style={inputStyle}
            >
              <option value="">All staff</option>
              {staffOpts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              style={inputStyle}
            />
          </label>
          {(staffFilter || from || to) && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setStaffFilter('');
                setFrom('');
                setTo('');
              }}
            >
              Clear
            </Button>
          )}
        </div>
        {loading ? (
          <div style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</div>
        ) : (
          <Table columns={cols} rows={rows} rowKey={(r) => r.id} empty="No appointments." />
        )}
      </Card>

      <Card title="Connection health">
        {readOnlyCount > 0 && (
          <p
            style={{
              fontSize: 13,
              color: tokens.color.warning,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.warning}`,
              borderRadius: tokens.radius.sm,
              padding: '8px 10px',
              marginTop: 0,
            }}
          >
            {readOnlyCount} staff member{readOnlyCount === 1 ? ' has a' : 's have'} read-only
            calendar connection{readOnlyCount === 1 ? '' : 's'}. Appointment write-back requires
            reconnecting to grant calendar write access.
          </p>
        )}
        <Table
          columns={healthCols}
          rows={health}
          rowKey={(r) => r.id}
          empty="No calendar connections."
        />
      </Card>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 4,
  fontSize: 12,
  color: tokens.color.textMuted,
};
const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.text,
  fontSize: 13,
};
