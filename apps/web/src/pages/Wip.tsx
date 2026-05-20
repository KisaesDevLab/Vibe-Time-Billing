// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface WipRow {
  engagementId: string;
  engagementName: string;
  clientId: string;
  clientName: string;
  hours: number;
  amountCents: number;
  entryCount: number;
  oldestDate: string | null;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

function daysSince(date: string | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - Date.parse(date)) / 86_400_000);
}

export function WipDashboardPage(): JSX.Element {
  const [rows, setRows] = useState<WipRow[]>([]);
  const [asOf, setAsOf] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ asOf: string; items: WipRow[] }>(
          '/api/staff/billing-batches/wip-dashboard',
        );
        setAsOf(r.asOf);
        setRows(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, []);

  const totalCents = rows.reduce((a, r) => a + r.amountCents, 0);
  const totalHours = rows.reduce((a, r) => a + r.hours, 0);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card title={`Firm-wide WIP · ${asOf || 'loading'}`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Stat label="Engagements with WIP" value={String(rows.length)} />
          <Stat label="Unbilled hours" value={totalHours.toFixed(2)} />
          <Stat label="Unbilled value" value={formatCents(totalCents)} />
        </div>
      </Card>
      <Card title="By engagement (largest first)">
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<WipRow>
          columns={[
            {
              key: 'client',
              header: 'Client',
              render: (r) => <a href={`/clients/${r.clientId}`}>{r.clientName}</a>,
            },
            {
              key: 'eng',
              header: 'Engagement',
              render: (r) => <a href={`/engagements/${r.engagementId}`}>{r.engagementName}</a>,
            },
            {
              key: 'hours',
              header: 'Hours',
              align: 'right',
              render: (r) => r.hours.toFixed(2),
            },
            {
              key: 'amount',
              header: 'Value',
              align: 'right',
              render: (r) => formatCents(r.amountCents),
            },
            {
              key: 'count',
              header: 'Entries',
              align: 'right',
              render: (r) => String(r.entryCount),
            },
            {
              key: 'age',
              header: 'Oldest',
              render: (r) => {
                const d = daysSince(r.oldestDate);
                if (d == null) return '—';
                return <Pill tone={d > 60 ? 'danger' : d > 30 ? 'warning' : 'neutral'}>{d}d</Pill>;
              },
            },
          ]}
          rows={rows}
          rowKey={(r) => r.engagementId}
          empty="No unbilled time entries."
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
