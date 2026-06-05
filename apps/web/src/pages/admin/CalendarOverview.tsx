// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
}

export function CalendarOverviewPage(): JSX.Element {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, h] = await Promise.all([
        api<{ items: OverviewRow[] }>('/api/staff/admin/calendar/overview'),
        api<{ connections: HealthRow[] }>('/api/staff/admin/calendar/health'),
      ]);
      setRows(o.items ?? []);
      setHealth(h.connections ?? []);
    } finally {
      setLoading(false);
    }
  }, []);
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
  ];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card
        title="All-staff appointments"
        action={
          <Button
            variant="secondary"
            onClick={() => window.open('/api/staff/admin/calendar/overview?format=csv', '_blank')}
          >
            Export CSV
          </Button>
        }
      >
        {loading ? (
          <div style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</div>
        ) : (
          <Table columns={cols} rows={rows} rowKey={(r) => r.id} empty="No appointments." />
        )}
      </Card>

      <Card title="Connection health">
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
