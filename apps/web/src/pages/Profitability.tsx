// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Button, Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Eng {
  id: string;
  name: string;
  clientName: string | null;
}

interface Summary {
  engagementId: string;
  costCents: number;
  billedCents: number;
  paidCents: number;
  marginCents: number;
  marginPct: number | null;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function ProfitabilityPage(): JSX.Element {
  const [engagements, setEngagements] = useState<Eng[]>([]);
  const [rows, setRows] = useState<Array<{ eng: Eng; summary: Summary | null }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function loadAll(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ items: Eng[] }>('/api/staff/engagements?status=ACTIVE&limit=200');
      const list = r.items ?? [];
      setEngagements(list);
      const results = await Promise.all(
        list.map(async (e) => {
          try {
            const s = await api<{ summary: Summary | null }>(
              `/api/staff/engagements/${e.id}/cost-vs-revenue`,
            );
            return { eng: e, summary: s.summary };
          } catch {
            return { eng: e, summary: null };
          }
        }),
      );
      setRows(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadAll();
  }, []);

  const visible = rows.filter(
    (r) => r.summary && (r.summary.billedCents > 0 || r.summary.costCents > 0),
  );

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title="Engagement profitability"
        action={
          <Button size="sm" variant="secondary" onClick={() => void loadAll()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        }
      >
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Cost is derived from each time entry&apos;s effective timekeeper cost rate. Revenue is the
          paid amount on invoices where this engagement is the primary engagement.
        </p>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<{ eng: Eng; summary: Summary | null }>
          columns={[
            {
              key: 'eng',
              header: 'Engagement',
              render: (r) => (
                <a href={`/engagements/${r.eng.id}`}>
                  {r.eng.clientName ? `${r.eng.clientName} · ` : ''}
                  {r.eng.name}
                </a>
              ),
            },
            {
              key: 'cost',
              header: 'Cost',
              align: 'right',
              render: (r) => (r.summary ? formatCents(r.summary.costCents) : '—'),
            },
            {
              key: 'billed',
              header: 'Billed',
              align: 'right',
              render: (r) => (r.summary ? formatCents(r.summary.billedCents) : '—'),
            },
            {
              key: 'paid',
              header: 'Paid',
              align: 'right',
              render: (r) => (r.summary ? formatCents(r.summary.paidCents) : '—'),
            },
            {
              key: 'margin',
              header: 'Margin',
              align: 'right',
              render: (r) => (r.summary ? formatCents(r.summary.marginCents) : '—'),
            },
            {
              key: 'pct',
              header: 'Margin %',
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
          empty="No engagement profitability data yet."
        />
        <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
          Showing {visible.length} of {engagements.length} active engagements with cost or revenue.
        </p>
      </Card>
    </div>
  );
}
