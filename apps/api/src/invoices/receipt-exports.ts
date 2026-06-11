// SPDX-License-Identifier: Elastic-2.0
//
// CP3 — per-payment receipt HTML builder. Extracted from
// apps/api/src/portal/invoices.ts so it's unit-testable and reusable
// (the planned per-receipt aggregated PDF will share this module
// when it lands as a follow-up).
//
// Privacy contract: this builder accepts only the columns the client
// is allowed to see. No payment_method_id, no fee_cents, no
// retry_count — keep firm-internal columns out of the input type so
// the receipt can't leak them by accident.

export interface ReceiptHtmlInput {
  firmName: string;
  clientName: string;
  invoiceNumber: string;
  paymentId: string;
  amountCents: number;
  receivedAt: Date | string;
  providerChargeId: string | null;
  /** Optional — date the payment was refunded. When set, the receipt
   *  renders a refunded banner instead of a "thank you" footer. */
  refundedAt?: Date | string | null;
  refundedAmountCents?: number | null;
}

export function renderReceiptHtml(args: ReceiptHtmlInput): string {
  const amount = (args.amountCents / 100).toFixed(2);
  const when = toIsoDate(args.receivedAt);
  const charge = args.providerChargeId
    ? `<p>Reference: ${escapeHtml(args.providerChargeId)}</p>`
    : '';
  const refundBanner =
    args.refundedAt && args.refundedAmountCents
      ? `<div style="margin:16px 0;padding:12px 16px;border:1px solid #e0a200;border-radius:8px;background:#fff8e6;color:#665100"><strong>Refunded:</strong> $${(
          args.refundedAmountCents / 100
        ).toFixed(2)} on ${escapeHtml(toIsoDate(args.refundedAt))}.</div>`
      : '';
  const footer = args.refundedAt
    ? '<p>Contact your firm if you have questions about this refund.</p>'
    : '<p>Thank you.</p>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Receipt ${escapeHtml(args.invoiceNumber)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#111}h1{font-size:1.4rem}table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid #eee}.r{text-align:right}</style></head>
<body><h1>Payment Receipt</h1>
<p><strong>${escapeHtml(args.firmName)}</strong></p>
<p>Received from ${escapeHtml(args.clientName)} on ${escapeHtml(when)}.</p>
${refundBanner}
<table>
<tr><td>Invoice</td><td class="r">${escapeHtml(args.invoiceNumber)}</td></tr>
<tr><td>Payment ID</td><td class="r">${escapeHtml(args.paymentId)}</td></tr>
<tr><td>Amount</td><td class="r">$${amount}</td></tr>
</table>
${charge}
${footer}
</body></html>`;
}

function toIsoDate(d: Date | string): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return new Date(s).toISOString().slice(0, 10);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
