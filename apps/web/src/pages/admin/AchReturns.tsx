// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin → ACH returns dashboard (Phase 22/26). Read-only view of ACH returns /
// late-failure disputes with their NACHA classification and the side effects
// applied (mandate invalidated, payment method blocked).

import { useEffect, useState } from 'react';

import { Button, Card, Pill, SectionHeading, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface AchReturnRow {
  id: string;
  returnCode: string;
  category: 'INSUFFICIENT_FUNDS' | 'NO_AUTHORIZATION' | 'ACCOUNT_ERROR' | 'OTHER';
  retriable: boolean;
  invalidatedMandate: boolean;
  blockedPaymentMethod: boolean;
  amountCents: number;
  feeCents: number;
  source: string;
  createdAt: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  clientName: string | null;
}

function dollars(c: number): string {
  return (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const CATEGORY_TONE: Record<AchReturnRow['category'], 'warning' | 'danger' | 'neutral'> = {
  INSUFFICIENT_FUNDS: 'warning',
  NO_AUTHORIZATION: 'danger',
  ACCOUNT_ERROR: 'danger',
  OTHER: 'neutral',
};

export function AchReturnsPage(): JSX.Element {
  const [rows, setRows] = useState<AchReturnRow[]>([]);
  const [summary, setSummary] = useState<{ count: number; amountCents: number }>({
    count: 0,
    amountCents: 0,
  });
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{
          items: AchReturnRow[];
          summary: { count: number; amountCents: number };
        }>('/api/staff/payments/ach-returns');
        setRows(r.items);
        setSummary(r.summary);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'load_failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1300, alignContent: 'start' }}>
      <SectionHeading
        title="ACH returns"
        description="Returned ACH debits and late-failure disputes, with the NACHA classification and the action taken automatically."
      />

      <Card>
        <div style={{ display: 'flex', gap: 32 }}>
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted }}>Returns</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{summary.count}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted }}>Returned amount</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{dollars(summary.amountCents)}</div>
          </div>
        </div>
        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 0 }}>{err}</p>}
      </Card>

      <Card title="Returns">
        {loading ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : (
          <Table<AchReturnRow>
            columns={[
              {
                key: 'date',
                header: 'Date',
                render: (r) => new Date(r.createdAt).toLocaleDateString(),
              },
              { key: 'client', header: 'Client', render: (r) => r.clientName ?? '—' },
              { key: 'invoice', header: 'Invoice', render: (r) => r.invoiceNumber ?? '—' },
              {
                key: 'code',
                header: 'Code',
                render: (r) => <code style={{ fontSize: 12 }}>{r.returnCode}</code>,
              },
              {
                key: 'category',
                header: 'Category',
                render: (r) => (
                  <Pill tone={CATEGORY_TONE[r.category]}>{r.category.replace(/_/g, ' ')}</Pill>
                ),
              },
              { key: 'amount', header: 'Amount', render: (r) => dollars(Number(r.amountCents)) },
              {
                key: 'source',
                header: 'Type',
                render: (r) => (r.source === 'dispute' ? 'Late dispute' : 'Return'),
              },
              {
                key: 'effect',
                header: 'Action taken',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {r.retriable && <Pill tone="neutral">retriable</Pill>}
                    {r.invalidatedMandate && <Pill tone="danger">mandate voided</Pill>}
                    {r.blockedPaymentMethod && <Pill tone="danger">bank blocked</Pill>}
                    {!r.retriable && !r.invalidatedMandate && !r.blockedPaymentMethod && (
                      <span style={{ color: tokens.color.textMuted }}>halted</span>
                    )}
                  </div>
                ),
              },
              {
                key: 'link',
                header: '',
                render: (r) =>
                  r.invoiceId ? (
                    <a href={`/invoices/${r.invoiceId}`} style={{ color: tokens.color.accent }}>
                      View
                    </a>
                  ) : null,
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            empty="No ACH returns — clean ACH history."
          />
        )}
      </Card>

      {rows.some((r) => r.invalidatedMandate) && (
        <Card>
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            A <strong>mandate voided</strong> result means the client must re-authorize ACH before
            any further debit; autopay schedules on that bank account are paused automatically.
          </p>
        </Card>
      )}

      <div>
        <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
