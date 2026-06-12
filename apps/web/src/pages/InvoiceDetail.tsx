// SPDX-License-Identifier: Elastic-2.0
//
// Invoice detail page — view / print / send only. Line items + the
// engagement-derived totals breakdown (Subtotal / Surcharge / Tax /
// Processing fee / Total) are read-only here: amounts are set upstream in
// Billing (the pre-bill screen), where adjustments allocate to each time
// entry. "Edit in Billing" routes to the source batch (or the Billing
// list when the invoice has no resolvable batch).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { formatCents } from '../lib/money';

type Status = 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOIDED';

type LineKind =
  | 'TIME_AGGREGATE'
  | 'FIXED_FEE'
  | 'MILESTONE'
  | 'RECURRING_FEE'
  | 'EXPENSE'
  | 'PROCESSING_FEE'
  | 'CUSTOM'
  | 'SURCHARGE'
  | 'SALES_TAX';

interface Invoice {
  id: string;
  firmId: string;
  clientId: string;
  primaryEngagementId: string | null;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  subtotalCents: number;
  surchargeCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  paidCents: number;
  status: Status;
  notes: string | null;
}

interface LineItem {
  id: string;
  kind: LineKind;
  description: string;
  amountCents: number;
  sortOrder: number;
}

function statusTone(s: Status): 'neutral' | 'accent' | 'warning' | 'success' | 'danger' {
  switch (s) {
    case 'PAID':
      return 'success';
    case 'OVERDUE':
      return 'danger';
    case 'PARTIALLY_PAID':
      return 'warning';
    case 'VOIDED':
      return 'neutral';
    default:
      return 'accent';
  }
}

export function InvoiceDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [lines, setLines] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPage, setShowPage] = useState(false);
  // Source billing batch (when generated from one) → drives "Edit in Billing".
  const [billingBatchId, setBillingBatchId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    try {
      const r = await api<{
        invoice: Invoice;
        lineItems: LineItem[];
        billingBatchId: string | null;
      }>(`/api/staff/invoices/${id}`);
      setInvoice(r.invoice);
      setLines((r.lineItems ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder));
      setBillingBatchId(r.billingBatchId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Manual line items (tax/surcharge are auto-derived and shown read-only
  // in the totals footer; filter them out of the line table).
  const manualLines = useMemo(
    () => lines.filter((l) => l.kind !== 'SURCHARGE' && l.kind !== 'SALES_TAX'),
    [lines],
  );

  // Editing happens upstream in Billing (where amounts allocate to time
  // entries). The invoice screen is view / print / send only — EXCEPT the
  // line-item description, which is cosmetic and editable here when the
  // invoice isn't locked (matches the backend: not voided, no payments).
  const descEditable = invoice != null && invoice.status !== 'VOIDED' && invoice.paidCents === 0;

  function editInBilling(): void {
    navigate(billingBatchId ? `/billing/${billingBatchId}` : '/billing');
  }

  async function saveDescription(lineId: string, description: string): Promise<void> {
    if (!invoice) return;
    setError(null);
    try {
      await api(`/api/staff/invoices/${invoice.id}/line-items/${lineId}`, {
        method: 'PATCH',
        body: JSON.stringify({ description }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    }
  }

  if (loading) return <p style={{ color: tokens.color.textMuted, padding: 16 }}>Loading…</p>;
  if (!invoice)
    return <p style={{ color: tokens.color.danger, padding: 16 }}>{error ?? 'Not found'}</p>;

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 960 }}>
      <Card
        title={
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>Invoice {invoice.invoiceNumber}</span>
            <Pill tone={statusTone(invoice.status)}>{invoice.status}</Pill>
            {invoice.paidCents > 0 && (
              <Pill tone="warning">{formatCents(invoice.paidCents)} paid</Pill>
            )}
          </span>
        }
        action={
          <span style={{ display: 'flex', gap: 6 }}>
            <Button
              size="sm"
              variant={showPage ? 'primary' : 'secondary'}
              onClick={() => setShowPage((v) => !v)}
            >
              {showPage ? 'Hide page' : 'View as page'}
            </Button>
            <a
              href={`/api/staff/invoices/${invoice.id}/pdf`}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: '4px 10px',
                fontSize: 12,
                color: tokens.color.text,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                textDecoration: 'none',
              }}
            >
              PDF
            </a>
            {invoice.status !== 'VOIDED' && invoice.paidCents === 0 && (
              <Button size="sm" onClick={editInBilling}>
                Edit in Billing
              </Button>
            )}
          </span>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
          Issued {invoice.issueDate} · Due {invoice.dueDate} · Amounts are set in Billing.
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: tokens.color.surface }}>
              <th style={th()}>Kind</th>
              <th style={th()}>Description</th>
              <th style={{ ...th(), textAlign: 'right' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {manualLines.length === 0 ? (
              <tr>
                <td colSpan={3} style={{ padding: 16, color: tokens.color.textMuted }}>
                  No line items.
                </td>
              </tr>
            ) : (
              manualLines.map((l) => (
                <LineRow
                  key={l.id}
                  line={l}
                  editable={descEditable}
                  onSaveDescription={(v) => void saveDescription(l.id, v)}
                />
              ))
            )}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: `2px solid ${tokens.color.border}` }}>
              <td colSpan={2} style={tdFoot('right')}>
                Subtotal
              </td>
              <td style={tdFoot('right')}>{formatCents(invoice.subtotalCents)}</td>
            </tr>
            {invoice.surchargeCents > 0 && (
              <tr>
                <td colSpan={2} style={tdFoot('right')}>
                  Surcharge
                </td>
                <td style={tdFoot('right')}>{formatCents(invoice.surchargeCents)}</td>
              </tr>
            )}
            {invoice.taxCents > 0 && (
              <tr>
                <td colSpan={2} style={tdFoot('right')}>
                  Sales tax
                </td>
                <td style={tdFoot('right')}>{formatCents(invoice.taxCents)}</td>
              </tr>
            )}
            {invoice.feeCents > 0 && (
              <tr>
                <td colSpan={2} style={tdFoot('right')}>
                  Processing fee
                </td>
                <td style={tdFoot('right')}>{formatCents(invoice.feeCents)}</td>
              </tr>
            )}
            <tr style={{ borderTop: `1px solid ${tokens.color.border}` }}>
              <td colSpan={2} style={{ ...tdFoot('right'), fontWeight: 700 }}>
                Total
              </td>
              <td style={{ ...tdFoot('right'), fontWeight: 700 }}>
                {formatCents(invoice.totalCents)}
              </td>
            </tr>
          </tfoot>
        </table>

        {(invoice.surchargeCents > 0 || invoice.taxCents > 0) && (
          <p
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              marginTop: 12,
            }}
          >
            Surcharge and sales tax are auto-derived from the engagement&apos;s tax/surcharge
            config.
          </p>
        )}
      </Card>

      {showPage && (
        // 8.5×11 page preview — the same letter-size HTML the PDF is rendered
        // from, shown on a gray backdrop like a print preview. Sits below the
        // editing card so the controls stay at the top.
        <div
          style={{
            background: '#525659',
            padding: 24,
            borderRadius: tokens.radius.md,
            display: 'flex',
            justifyContent: 'center',
            overflow: 'auto',
          }}
        >
          <iframe
            title={`Invoice ${invoice.invoiceNumber} — page view`}
            src={`/api/staff/invoices/${invoice.id}/pdf?format=html`}
            style={{
              width: 816,
              height: 1056,
              maxWidth: '100%',
              border: 'none',
              background: '#fff',
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
            }}
          />
        </div>
      )}
    </div>
  );
}

function LineRow({
  line,
  editable,
  onSaveDescription,
}: {
  line: LineItem;
  editable: boolean;
  onSaveDescription: (v: string) => void;
}): JSX.Element {
  const [desc, setDesc] = useState(line.description);
  useEffect(() => setDesc(line.description), [line.id, line.description]);
  return (
    <tr style={{ borderTop: `1px solid ${tokens.color.border}` }}>
      <td style={td()}>
        <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
          {line.kind.replace(/_/g, ' ')}
        </span>
      </td>
      <td style={td()}>
        {editable ? (
          <input
            type="text"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              const v = desc.trim();
              if (v && v !== line.description) onSaveDescription(v);
              else if (!v) setDesc(line.description);
            }}
            aria-label={`Description for ${line.kind}`}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '4px 8px',
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.bg,
              color: tokens.color.text,
              fontSize: 13,
            }}
          />
        ) : (
          line.description
        )}
      </td>
      <td style={{ ...td(), textAlign: 'right' }}>{formatCents(line.amountCents)}</td>
    </tr>
  );
}

function th(): React.CSSProperties {
  return {
    padding: '6px 8px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: tokens.color.textMuted,
    textAlign: 'left',
    fontWeight: 600,
  };
}
function td(): React.CSSProperties {
  return { padding: '8px', verticalAlign: 'middle' };
}
function tdFoot(align: 'left' | 'right'): React.CSSProperties {
  return { padding: '6px 8px', textAlign: align, fontSize: 13 };
}
