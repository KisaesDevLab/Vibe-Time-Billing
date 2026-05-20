// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Client {
  id: string;
  name: string;
  status: string;
  termsDays: number;
  invoiceConsolidationPreference: 'CONSOLIDATED' | 'SEPARATE';
  partnerInChargeId: string | null;
  createdAt: string;
}

interface Engagement {
  id: string;
  name: string;
  status: string;
  feeStructure: string;
  feeAmountCents: number | null;
}

interface Summary {
  clientId: string;
  engagementCount: number;
  activeEngagementCount: number;
  invoiceCount: number;
  invoicedCents: number;
  paidCents: number;
  outstandingCents: number;
  wipHours: number;
  wipAmountCents: number;
}

const formatCents = (c: number): string => `$${(c / 100).toLocaleString()}`;

export function ClientDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const [client, setClient] = useState<Client | null>(null);
  const [engagements, setEngagements] = useState<Engagement[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const [c, e, s] = await Promise.all([
          api<{ client: Client }>(`/api/staff/clients/${id}`),
          api<{ items: Engagement[] }>(`/api/staff/engagements?clientId=${id}`),
          api<{ summary: Summary | null }>(`/api/staff/stats/client/${id}`),
        ]);
        setClient(c.client);
        setEngagements(e.items ?? []);
        setSummary(s.summary);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, [id]);

  if (error) {
    return (
      <Card title="Error">
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>
      </Card>
    );
  }
  if (!client) {
    return (
      <Card title="Client">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card
        title={client.name}
        action={
          <Pill tone={client.status === 'ACTIVE' ? 'success' : 'neutral'}>{client.status}</Pill>
        }
      >
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '6px 16px',
            fontSize: 13,
            margin: 0,
          }}
        >
          <dt style={{ color: tokens.color.textMuted }}>Terms</dt>
          <dd style={{ margin: 0 }}>{client.termsDays} days</dd>
          <dt style={{ color: tokens.color.textMuted }}>Consolidation</dt>
          <dd style={{ margin: 0 }}>{client.invoiceConsolidationPreference}</dd>
          <dt style={{ color: tokens.color.textMuted }}>Created</dt>
          <dd style={{ margin: 0 }}>{client.createdAt.slice(0, 10)}</dd>
        </dl>
      </Card>

      {summary && (
        <Card title="At a glance">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, 1fr)',
              gap: 16,
            }}
          >
            <Stat
              label="Engagements"
              value={`${summary.activeEngagementCount} / ${summary.engagementCount}`}
            />
            <Stat label="WIP" value={formatCents(summary.wipAmountCents)} />
            <Stat label="Invoiced" value={formatCents(summary.invoicedCents)} />
            <Stat label="Paid" value={formatCents(summary.paidCents)} />
            <Stat label="Outstanding" value={formatCents(summary.outstandingCents)} />
          </div>
        </Card>
      )}

      <Card title={`Engagements (${engagements.length})`}>
        <Table<Engagement>
          columns={[
            {
              key: 'name',
              header: 'Name',
              render: (e) => <a href={`/engagements/${e.id}`}>{e.name}</a>,
            },
            { key: 'fee', header: 'Fee structure', render: (e) => e.feeStructure },
            {
              key: 'amt',
              header: 'Fee amount',
              align: 'right',
              render: (e) => (e.feeAmountCents == null ? '—' : formatCents(e.feeAmountCents)),
            },
            {
              key: 'status',
              header: 'Status',
              render: (e) => (
                <Pill tone={e.status === 'ACTIVE' ? 'success' : 'neutral'}>{e.status}</Pill>
              ),
            },
          ]}
          rows={engagements}
          rowKey={(e) => e.id}
          empty="No engagements yet."
        />
      </Card>
    </div>
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
