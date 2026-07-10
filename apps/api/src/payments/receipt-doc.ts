// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Printable payment receipt. A receipt groups one received payment (or
// charge) across one-or-many invoices; this renders a self-contained HTML
// document staff can print, save as PDF, or email to the client's billing
// contact. Also exposes loadReceiptDoc so both the receipt print endpoint
// and the worker's terminal-receipt auto-print share one loader.

import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, firms, invoices, paymentReceipts, payments } from '@vibe/db/schema';

export interface PaymentReceiptDoc {
  firmName: string;
  receiptId: string;
  paymentDate: string; // YYYY-MM-DD
  methodLabel: string;
  reference: string | null;
  payerName: string;
  totalCents: number;
  lines: { invoiceNumber: string; amountCents: number }[];
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export function renderPaymentReceiptHtml(doc: PaymentReceiptDoc): string {
  const rows = doc.lines
    .map(
      (l) =>
        `<tr><td>Invoice #${esc(l.invoiceNumber)}</td><td class="r">${money(l.amountCents)}</td></tr>`,
    )
    .join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Payment receipt — ${esc(doc.firmName)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 640px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .muted { color: #666; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; margin-bottom: 16px; }
  .meta { margin: 16px 0; display: grid; grid-template-columns: 140px 1fr; row-gap: 6px; font-size: 14px; }
  .meta dt { color: #666; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 14px; }
  th, td { text-align: left; padding: 8px 0; border-bottom: 1px solid #e5e5e5; }
  td.r, th.r { text-align: right; }
  tfoot td { font-weight: 700; border-bottom: none; border-top: 2px solid #1a1a1a; padding-top: 10px; }
  .total { font-size: 16px; }
  @media print { body { margin: 0; } }
</style></head>
<body>
  <div class="head">
    <div>
      <h1>${esc(doc.firmName)}</h1>
      <div class="muted">Payment receipt</div>
    </div>
    <div class="muted" style="text-align:right; font-size:13px;">
      Receipt ${esc(doc.receiptId.slice(0, 8))}<br/>${esc(doc.paymentDate)}
    </div>
  </div>

  <div class="meta">
    <dt>Received from</dt><dd>${esc(doc.payerName)}</dd>
    <dt>Date</dt><dd>${esc(doc.paymentDate)}</dd>
    <dt>Method</dt><dd>${esc(doc.methodLabel)}</dd>
    ${doc.reference ? `<dt>Reference</dt><dd>${esc(doc.reference)}</dd>` : ''}
  </div>

  <table>
    <thead><tr><th>Applied to</th><th class="r">Amount</th></tr></thead>
    <tbody>${rows || '<tr><td class="muted">Recorded as a credit</td><td class="r">—</td></tr>'}</tbody>
    <tfoot><tr><td class="total">Total received</td><td class="r total">${money(doc.totalCents)}</td></tr></tfoot>
  </table>

  <p class="muted" style="margin-top:24px; font-size:12px;">
    Thank you for your payment. Please retain this receipt for your records.
  </p>
</body></html>`;
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CHECK: 'Check',
  CASH: 'Cash',
  ACH: 'ACH transfer',
  WIRE: 'Wire transfer',
  CARD_STRIPE: 'Card (Stripe)',
  CARD: 'Card',
  CREDIT: 'Account credit',
  OTHER: 'Other',
};

export function methodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method.toUpperCase()] ?? method;
}

/** Load a firm-scoped receipt into the renderable PaymentReceiptDoc shape.
 *  Shared by the staff receipt print endpoint and the worker's terminal
 *  auto-print consumer. Returns null when the receipt isn't found. */
export async function loadReceiptDoc(
  db: Database,
  firmId: string,
  receiptId: string,
): Promise<{ doc: PaymentReceiptDoc; payerClientId: string } | null> {
  const [receipt] = await db
    .select({
      id: paymentReceipts.id,
      payerClientId: paymentReceipts.payerClientId,
      paymentDate: paymentReceipts.paymentDate,
      paymentMethod: paymentReceipts.paymentMethod,
      reference: paymentReceipts.reference,
      totalCents: paymentReceipts.totalCents,
      payerName: clients.name,
    })
    .from(paymentReceipts)
    .innerJoin(clients, eq(clients.id, paymentReceipts.payerClientId))
    .where(and(eq(paymentReceipts.id, receiptId), eq(paymentReceipts.firmId, firmId)))
    .limit(1);
  if (!receipt) return null;
  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, firmId))
    .limit(1);
  const lineRows = await db
    .select({ invoiceNumber: invoices.invoiceNumber, amountCents: payments.amountCents })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(and(eq(payments.receiptId, receiptId), isNull(payments.voidedAt)))
    .orderBy(asc(invoices.invoiceNumber));
  const paymentDate =
    typeof receipt.paymentDate === 'string'
      ? receipt.paymentDate
      : new Date(receipt.paymentDate as unknown as Date).toISOString().slice(0, 10);
  return {
    payerClientId: receipt.payerClientId,
    doc: {
      firmName: firm?.name ?? 'Your firm',
      receiptId: receipt.id,
      paymentDate,
      methodLabel: methodLabel(receipt.paymentMethod),
      reference: receipt.reference,
      payerName: receipt.payerName,
      totalCents: Number(receipt.totalCents),
      lines: lineRows.map((l) => ({
        invoiceNumber: l.invoiceNumber,
        amountCents: Number(l.amountCents),
      })),
    },
  };
}
