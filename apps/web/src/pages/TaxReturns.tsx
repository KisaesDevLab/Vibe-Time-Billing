// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-staff — list every tax return for the firm. Read-only surface
// driven by GET /api/staff/tax/returns. Row click → detail page.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, EmptyState, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface ReturnRow {
  id: string;
  clientId: string;
  clientName: string;
  taxYear: number;
  formCode: string;
  jurisdiction: string;
  title: string;
  status: string;
  releaseKind: 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED';
  totalPages: number | null;
  releasedAt: string | null;
  createdAt: string;
}

function statusTone(s: string): 'success' | 'warning' | 'neutral' | 'accent' {
  if (s === 'released') return 'success';
  if (s === 'amended') return 'warning';
  if (s === 'superseded') return 'neutral';
  return 'accent';
}

export function TaxReturnsStaffPage(): JSX.Element {
  const [items, setItems] = useState<ReturnRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ReturnRow[] }>('/api/staff/tax/returns');
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Tax returns">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
        )}
        {loading ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState
            title="No tax returns yet"
            body="When a return is parsed into the system it appears here, ready for review and release."
          />
        ) : (
          <Table<ReturnRow>
            columns={[
              {
                key: 'client',
                header: 'Client',
                render: (r) => (
                  <Link
                    to={`/tax/returns/${r.id}`}
                    style={{ color: tokens.color.accent, textDecoration: 'none', fontWeight: 500 }}
                  >
                    {r.clientName}
                  </Link>
                ),
              },
              { key: 'year', header: 'Year', render: (r) => String(r.taxYear) },
              {
                key: 'form',
                header: 'Form',
                render: (r) => `${r.formCode} · ${r.jurisdiction}`,
              },
              { key: 'title', header: 'Title', render: (r) => r.title || '—' },
              {
                key: 'kind',
                header: 'Type',
                render: (r) => (
                  <Pill tone={r.releaseKind === 'AMENDED' ? 'warning' : 'accent'}>
                    {r.releaseKind}
                  </Pill>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (r) => <Pill tone={statusTone(r.status)}>{r.status}</Pill>,
              },
              {
                key: 'pages',
                header: 'Pages',
                align: 'right',
                render: (r) => (r.totalPages != null ? String(r.totalPages) : '—'),
              },
              {
                key: 'released',
                header: 'Released',
                render: (r) => (r.releasedAt ? new Date(r.releasedAt).toLocaleDateString() : '—'),
              },
            ]}
            rows={items}
            rowKey={(r) => r.id}
            empty="No returns."
          />
        )}
      </Card>
    </div>
  );
}
