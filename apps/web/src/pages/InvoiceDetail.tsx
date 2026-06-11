// SPDX-License-Identifier: Elastic-2.0
//
// Invoice detail + edit page. Read mode shows the line items + the
// engagement-derived totals breakdown (Subtotal / Surcharge / Tax /
// Processing fee / Total). Edit mode (only available when
// paidCents === 0 && status !== VOIDED) lets the partner change line
// item descriptions / amounts, add new lines, and delete lines. Each
// save round-trips through the line-item endpoints which call the
// shared recomputeInvoiceTotals helper so tax + surcharge stay in
// sync with the engagement's current config.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Combobox, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { centsToDollarsInput, dollarsInputToCents, formatCents } from '../lib/money';

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

const MANUAL_KINDS: { value: LineKind; label: string }[] = [
  { value: 'TIME_AGGREGATE', label: 'Time' },
  { value: 'FIXED_FEE', label: 'Fixed fee' },
  { value: 'MILESTONE', label: 'Milestone' },
  { value: 'RECURRING_FEE', label: 'Recurring fee' },
  { value: 'EXPENSE', label: 'Expense' },
  { value: 'CUSTOM', label: 'Custom' },
];

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
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showPage, setShowPage] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    setLoading(true);
    try {
      const r = await api<{ invoice: Invoice; lineItems: LineItem[] }>(`/api/staff/invoices/${id}`);
      setInvoice(r.invoice);
      setLines((r.lineItems ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const locked = useMemo(() => {
    if (!invoice) return true;
    return invoice.paidCents > 0 || invoice.status === 'VOIDED';
  }, [invoice]);

  // Manual line items the user can edit. Tax/surcharge are auto-derived
  // and shown read-only in the totals footer; we filter them out of the
  // editable table.
  const manualLines = useMemo(
    () => lines.filter((l) => l.kind !== 'SURCHARGE' && l.kind !== 'SALES_TAX'),
    [lines],
  );

  async function patchLine(
    line: LineItem,
    patch: { description?: string; amountCents?: number },
  ): Promise<void> {
    if (!invoice) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/invoices/${invoice.id}/line-items/${line.id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function deleteLine(line: LineItem): Promise<void> {
    if (!invoice) return;
    if (!confirm(`Delete line "${line.description}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/invoices/${invoice.id}/line-items/${line.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete_failed');
    } finally {
      setBusy(false);
    }
  }

  async function addLine(): Promise<void> {
    if (!invoice) return;
    const description = prompt('Description');
    if (!description || !description.trim()) return;
    const amountStr = prompt('Amount ($)');
    if (!amountStr) return;
    const amountCents = dollarsInputToCents(amountStr);
    if (amountCents == null) {
      setError('invalid_amount');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/invoices/${invoice.id}/line-items`, {
        method: 'POST',
        body: JSON.stringify({
          kind: 'CUSTOM',
          description: description.trim(),
          amountCents,
          engagementId: invoice.primaryEngagementId,
        }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  async function reopen(): Promise<void> {
    if (!invoice) return;
    if (!confirm('Re-open this invoice? The current copy will be voided and a new draft created.'))
      return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string }>(`/api/staff/invoices/${invoice.id}/reopen`, {
        method: 'POST',
      });
      navigate(`/invoices/${r.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reopen_failed');
    } finally {
      setBusy(false);
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
            {invoice.status === 'SENT' && !locked && (
              <Button size="sm" variant="secondary" onClick={() => void reopen()} disabled={busy}>
                Re-open for editing
              </Button>
            )}
            {!locked &&
              (editing ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
                  Done
                </Button>
              ) : (
                <Button size="sm" onClick={() => setEditing(true)} disabled={busy}>
                  Edit
                </Button>
              ))}
          </span>
        }
      >
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
            {error}
          </p>
        )}
        {locked && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 8 }}>
            This invoice is locked
            {invoice.paidCents > 0 ? ` (${formatCents(invoice.paidCents)} paid)` : ''}
            {invoice.status === 'VOIDED' ? ' (voided)' : ''}. Reverse the payment or void to edit.
          </p>
        )}
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
          Issued {invoice.issueDate} · Due {invoice.dueDate}
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: tokens.color.surface }}>
              <th style={th()}>Kind</th>
              <th style={th()}>Description</th>
              <th style={{ ...th(), textAlign: 'right' }}>Amount</th>
              {editing && <th style={th()} />}
            </tr>
          </thead>
          <tbody>
            {manualLines.length === 0 ? (
              <tr>
                <td
                  colSpan={editing ? 4 : 3}
                  style={{ padding: 16, color: tokens.color.textMuted }}
                >
                  No line items.
                </td>
              </tr>
            ) : (
              manualLines.map((l) => (
                <LineRow
                  key={l.id}
                  line={l}
                  editing={editing}
                  busy={busy}
                  onSaveDescription={(v) => void patchLine(l, { description: v })}
                  onSaveAmount={(v) => void patchLine(l, { amountCents: v })}
                  onDelete={() => void deleteLine(l)}
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
              {editing && <td />}
            </tr>
            {invoice.surchargeCents > 0 && (
              <tr>
                <td colSpan={2} style={tdFoot('right')}>
                  Surcharge
                </td>
                <td style={tdFoot('right')}>{formatCents(invoice.surchargeCents)}</td>
                {editing && <td />}
              </tr>
            )}
            {invoice.taxCents > 0 && (
              <tr>
                <td colSpan={2} style={tdFoot('right')}>
                  Sales tax
                </td>
                <td style={tdFoot('right')}>{formatCents(invoice.taxCents)}</td>
                {editing && <td />}
              </tr>
            )}
            {invoice.feeCents > 0 && (
              <tr>
                <td colSpan={2} style={tdFoot('right')}>
                  Processing fee
                </td>
                <td style={tdFoot('right')}>{formatCents(invoice.feeCents)}</td>
                {editing && <td />}
              </tr>
            )}
            <tr style={{ borderTop: `1px solid ${tokens.color.border}` }}>
              <td colSpan={2} style={{ ...tdFoot('right'), fontWeight: 700 }}>
                Total
              </td>
              <td style={{ ...tdFoot('right'), fontWeight: 700 }}>
                {formatCents(invoice.totalCents)}
              </td>
              {editing && <td />}
            </tr>
          </tfoot>
        </table>

        {editing && (
          <div style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => void addLine()} disabled={busy}>
              + Add line
            </Button>
          </div>
        )}

        {(invoice.surchargeCents > 0 || invoice.taxCents > 0) && (
          <p
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              marginTop: 12,
            }}
          >
            Surcharge and sales tax are auto-derived from the engagement&apos;s tax/surcharge config
            and recompute whenever the line items change.
          </p>
        )}
      </Card>

      {/* Type kind picker (purely informational — surfaces what the
          backend would let you POST). */}
      {editing && (
        <Card title="Add specific kind">
          <KindPicker
            invoiceId={invoice.id}
            engagementId={invoice.primaryEngagementId}
            onAdded={() => void load()}
          />
        </Card>
      )}

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
  editing,
  busy,
  onSaveDescription,
  onSaveAmount,
  onDelete,
}: {
  line: LineItem;
  editing: boolean;
  busy: boolean;
  onSaveDescription: (v: string) => void;
  onSaveAmount: (v: number) => void;
  onDelete: () => void;
}): JSX.Element {
  const [desc, setDesc] = useState(line.description);
  const [amount, setAmount] = useState(centsToDollarsInput(line.amountCents));

  useEffect(() => {
    setDesc(line.description);
    setAmount(centsToDollarsInput(line.amountCents));
  }, [line.id, line.description, line.amountCents]);

  return (
    <tr style={{ borderTop: `1px solid ${tokens.color.border}` }}>
      <td style={td()}>
        <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
          {line.kind.replace(/_/g, ' ')}
        </span>
      </td>
      <td style={td()}>
        {editing ? (
          <input
            type="text"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => {
              if (desc !== line.description && desc.trim().length > 0) onSaveDescription(desc);
            }}
            disabled={busy}
            style={inputStyle()}
            aria-label={`Description for ${line.kind}`}
          />
        ) : (
          line.description
        )}
      </td>
      <td style={{ ...td(), textAlign: 'right' }}>
        {editing ? (
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={() => {
              const v = dollarsInputToCents(amount);
              if (v != null && v !== line.amountCents) onSaveAmount(v);
            }}
            disabled={busy}
            style={{ ...inputStyle(), textAlign: 'right', width: 110 }}
            aria-label={`Amount for ${line.description}`}
          />
        ) : (
          formatCents(line.amountCents)
        )}
      </td>
      {editing && (
        <td style={{ ...td(), textAlign: 'right' }}>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>
            Delete
          </Button>
        </td>
      )}
    </tr>
  );
}

function KindPicker({
  invoiceId,
  engagementId,
  onAdded,
}: {
  invoiceId: string;
  engagementId: string | null;
  onAdded: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<LineKind>('CUSTOM');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!description.trim()) {
      setError('description_required');
      return;
    }
    const amountCents = dollarsInputToCents(amount);
    if (amountCents == null) {
      setError('invalid_amount');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/invoices/${invoiceId}/line-items`, {
        method: 'POST',
        body: JSON.stringify({ kind, description: description.trim(), amountCents, engagementId }),
      });
      setDescription('');
      setAmount('');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'add_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 140px auto', gap: 8 }}>
      <Combobox
        ariaLabel="Line kind"
        value={kind}
        onChange={(v) => setKind(v as LineKind)}
        options={MANUAL_KINDS}
      />
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description"
        style={inputStyle()}
        aria-label="New line description"
      />
      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.00"
        style={{ ...inputStyle(), textAlign: 'right' }}
        aria-label="New line amount"
      />
      <Button onClick={() => void submit()} disabled={busy}>
        Add
      </Button>
      {error && (
        <p style={{ gridColumn: '1 / -1', fontSize: 12, color: tokens.color.danger, margin: 0 }}>
          {error}
        </p>
      )}
    </div>
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
function inputStyle(): React.CSSProperties {
  return {
    padding: '4px 8px',
    border: `1px solid ${tokens.color.border}`,
    borderRadius: tokens.radius.sm,
    background: tokens.color.bg,
    color: tokens.color.text,
    fontSize: 13,
    width: '100%',
  };
}
