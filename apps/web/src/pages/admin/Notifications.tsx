// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Row {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  stepKind: string;
  sentAt: string;
  channel: string | null;
  recipient: string | null;
  outcome: string;
  errorMessage: string | null;
}

export function NotificationsPage(): JSX.Element {
  const [items, setItems] = useState<Row[]>([]);
  const [days, setDays] = useState(14);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: Row[] }>(`/api/staff/audit/notifications/recent?days=${days}`);
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      }
    })();
  }, [days]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Card title="Outbound notifications">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Dunning + invoice + payment notifications dispatched by the worker. The dunning worker
          writes one row per delivery attempt; failures keep the error text for debugging.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
          <label style={{ fontSize: 13 }}>
            Window:
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              style={{
                marginLeft: 8,
                padding: '4px 8px',
                borderRadius: tokens.radius.sm,
                border: `1px solid ${tokens.color.border}`,
              }}
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
        <Table<Row>
          columns={[
            { key: 'when', header: 'Sent', render: (r) => new Date(r.sentAt).toLocaleString() },
            { key: 'inv', header: 'Invoice', render: (r) => r.invoiceNumber },
            { key: 'step', header: 'Step', render: (r) => r.stepKind },
            { key: 'channel', header: 'Channel', render: (r) => r.channel ?? '—' },
            { key: 'to', header: 'Recipient', render: (r) => r.recipient ?? '—' },
            {
              key: 'outcome',
              header: 'Outcome',
              render: (r) => (
                <Pill tone={r.outcome === 'SENT' ? 'success' : 'danger'}>{r.outcome}</Pill>
              ),
            },
            {
              key: 'err',
              header: 'Error',
              render: (r) =>
                r.errorMessage ? (
                  <span style={{ fontSize: 11, color: tokens.color.danger }}>
                    {r.errorMessage.slice(0, 80)}
                  </span>
                ) : null,
            },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          empty="No notifications in this window."
        />
      </Card>
    </div>
  );
}
