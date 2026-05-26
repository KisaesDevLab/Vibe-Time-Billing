// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-4 — Portal tax-return list. Renders every release the active
// client has access to. Selecting a row navigates to the viewer.
//
// Source: GET /api/portal/tax/returns

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, EmptyState, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface ReleasedReturnView {
  returnId: string;
  releaseId: string;
  taxYear: number;
  formCode: string;
  jurisdiction: string;
  title: string;
  totalPages: number | null;
  releasedAt: string;
  releaseKind: 'ORIGINAL' | 'AMENDED' | 'SUPERSEDED';
  clientCanDownload: boolean;
  coverNote: string | null;
  scope: 'FULL' | 'SELECTED';
}

function releaseKindTone(k: ReleasedReturnView['releaseKind']): 'neutral' | 'warning' | 'accent' {
  if (k === 'AMENDED') return 'warning';
  if (k === 'SUPERSEDED') return 'neutral';
  return 'accent';
}

export function TaxReturnsPage(): JSX.Element {
  const [items, setItems] = useState<ReleasedReturnView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ReleasedReturnView[] }>('/api/portal/tax/returns');
        setItems(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div style={{ maxWidth: 900 }}>
        <Card title="Tax returns">
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="Tax returns">
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
        )}
        {items.length === 0 ? (
          <EmptyState
            title="No returns released yet"
            body="When your firm releases a tax return for your review, it will appear here."
          />
        ) : (
          <Table<ReleasedReturnView>
            columns={[
              { key: 'year', header: 'Year', render: (r) => String(r.taxYear) },
              {
                key: 'title',
                header: 'Return',
                render: (r) => (
                  <Link
                    to={`/tax/returns/${r.returnId}`}
                    style={{
                      color: tokens.color.accent,
                      textDecoration: 'none',
                      fontWeight: 500,
                    }}
                  >
                    {r.title || `${r.formCode} (${r.jurisdiction})`}
                  </Link>
                ),
              },
              {
                key: 'form',
                header: 'Form',
                render: (r) => `${r.formCode} · ${r.jurisdiction}`,
              },
              {
                key: 'kind',
                header: 'Type',
                render: (r) => <Pill tone={releaseKindTone(r.releaseKind)}>{r.releaseKind}</Pill>,
              },
              {
                key: 'scope',
                header: 'Scope',
                render: (r) =>
                  r.scope === 'FULL' ? (
                    <Pill tone="success">Full</Pill>
                  ) : (
                    <Pill tone="neutral">Selected sections</Pill>
                  ),
              },
              {
                key: 'released',
                header: 'Released',
                render: (r) => new Date(r.releasedAt).toLocaleDateString(),
              },
            ]}
            rows={items}
            rowKey={(r) => r.releaseId}
            empty="No returns."
          />
        )}
      </Card>
    </div>
  );
}
