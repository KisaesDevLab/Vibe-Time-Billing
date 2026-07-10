// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useEffect, useState } from 'react';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface Letter {
  id: string;
  engagementId: string;
  version: number;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'VOIDED';
  sentAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

export function EngagementLettersPage(): JSX.Element {
  const [items, setItems] = useState<Letter[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');

  useEffect(() => {
    const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    void (async () => {
      try {
        const r = await api<{ items: Letter[] }>(`/api/staff/engagement-letters${q}`);
        setItems(r.items ?? []);
      } catch {
        // ignore
      }
    })();
  }, [statusFilter]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Engagement letters">
        <label style={{ fontSize: 13, display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          Status filter:
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              padding: '4px 8px',
              borderRadius: tokens.radius.sm,
              border: `1px solid ${tokens.color.border}`,
            }}
          >
            <option value="">All</option>
            <option value="DRAFT">DRAFT</option>
            <option value="SENT">SENT</option>
            <option value="ACCEPTED">ACCEPTED</option>
            <option value="REJECTED">REJECTED</option>
            <option value="VOIDED">VOIDED</option>
          </select>
        </label>
        <Table<Letter>
          columns={[
            { key: 'eng', header: 'Engagement', render: (l) => l.engagementId.slice(0, 8) },
            { key: 'v', header: 'v', render: (l) => `v${l.version}` },
            {
              key: 'status',
              header: 'Status',
              render: (l) => (
                <Pill tone={l.status === 'ACCEPTED' ? 'accent' : 'neutral'}>{l.status}</Pill>
              ),
            },
            {
              key: 'sent',
              header: 'Sent',
              render: (l) => (l.sentAt ? l.sentAt.slice(0, 10) : '—'),
            },
            {
              key: 'acc',
              header: 'Accepted',
              render: (l) => (l.acceptedAt ? l.acceptedAt.slice(0, 10) : '—'),
            },
            { key: 'created', header: 'Created', render: (l) => l.createdAt.slice(0, 10) },
          ]}
          rows={items}
          rowKey={(l) => l.id}
          empty="No letters yet."
        />
      </Card>
    </div>
  );
}
