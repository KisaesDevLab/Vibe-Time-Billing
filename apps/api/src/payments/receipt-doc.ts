// SPDX-License-Identifier: Elastic-2.0
//
// Printable payment receipt. A receipt groups one received payment (or
// charge) across one-or-many invoices; this renders a self-contained HTML
// document staff can print, save as PDF, or email to the client's billing
// contact.

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
