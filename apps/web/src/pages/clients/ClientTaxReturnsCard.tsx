// SPDX-License-Identifier: Elastic-2.0
//
// Per-client tax returns card. Sits at the top of the client dashboard
// Tax tab above the existing TaxPaymentsCard, so staff can see every
// return that's been parsed (or flagged via the Files tab) for this
// client without leaving the dashboard.
//
// Backed by GET /api/staff/tax/returns?clientId=. Row click → the
// full TaxReturnDetail page where sections / releases / amendments live.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { Card, Pill, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface ReturnRow {
  id: string;
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

export function ClientTaxReturnsCard({ clientId }: { clientId: string }): JSX.Element {
  const [rows, setRows] = useState<ReturnRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ReturnRow[] }>(`/api/staff/tax/returns?clientId=${clientId}`);
        setRows(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load_failed');
        setRows([]);
      }
    })();
  }, [clientId]);

  return (
    <Card title="Tax returns">
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{error}</p>
      )}
      {rows == null ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          No tax returns yet for this client. Use the <strong>Files</strong> tab to flag a PDF as a
          tax return, and it&apos;ll appear here in <em>draft</em> ready for sectioning and release.
        </p>
      ) : (
        <Table<ReturnRow>
          columns={[
            {
              key: 'title',
              header: 'Title',
              render: (r) => (
                <Link
                  to={`/tax/returns/${r.id}`}
                  style={{ color: tokens.color.accent, textDecoration: 'none', fontWeight: 500 }}
                >
                  {r.title}
                </Link>
              ),
            },
            { key: 'year', header: 'Year', render: (r) => String(r.taxYear) },
            {
              key: 'form',
              header: 'Form',
              render: (r) => `${r.formCode} · ${r.jurisdiction}`,
            },
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
          rows={rows}
          rowKey={(r) => r.id}
          empty=""
        />
      )}
    </Card>
  );
}
