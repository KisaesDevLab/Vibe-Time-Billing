// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// HTML templates for invoice PDFs. Plain text-interpolation — Q28 says
// no Markdown / WYSIWYG, just variable substitution. The Puppeteer
// renderer (apps/api/src/pdf/render.ts) takes the HTML output of these
// functions and prints to A4 PDF.

import type { Cents, IsoDate } from '@vibe/types';

import type { LineItem } from './composition';

export interface InvoiceTemplateInput {
  invoiceNumber: string;
  issueDate: IsoDate;
  dueDate: IsoDate;
  firm: { name: string; logoUrl?: string | null; address?: string | null };
  client: { name: string; billingAddress?: string | null };
  lines: LineItem[];
  subtotalCents: Cents;
  processingFeeCents: Cents;
  totalCents: Cents;
  notes?: string | null;
}

const cents = (c: Cents): string => `$${(c / 100).toFixed(2)}`;
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderInvoiceHtml(input: InvoiceTemplateInput): string {
  const linesHtml = input.lines
    .map(
      (l) => `<tr><td>${esc(l.description)}</td><td class="amt">${cents(l.amountCents)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice ${esc(input.invoiceNumber)}</title>
  <style>
    body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #111; margin: 32px; }
    header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; }
    header h1 { font-size: 22px; margin: 0; }
    header .meta { text-align: right; font-size: 12px; color: #444; }
    .parties { display: flex; gap: 48px; margin-bottom: 24px; }
    .parties h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #666; margin: 0 0 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { padding: 8px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
    th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #666; }
    td.amt, th.amt { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { border-bottom: none; border-top: 1px solid #ccc; padding-top: 12px; }
    .total { font-weight: 600; font-size: 16px; }
    .notes { margin-top: 24px; padding: 12px; background: #f7f7f8; border-radius: 4px; font-size: 12px; color: #444; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${esc(input.firm.name)}</h1>
      ${input.firm.address ? `<div>${esc(input.firm.address)}</div>` : ''}
    </div>
    <div class="meta">
      <div><strong>Invoice #${esc(input.invoiceNumber)}</strong></div>
      <div>Issued ${esc(input.issueDate)}</div>
      <div>Due ${esc(input.dueDate)}</div>
    </div>
  </header>
  <section class="parties">
    <div>
      <h3>Bill to</h3>
      <div>${esc(input.client.name)}</div>
      ${input.client.billingAddress ? `<div>${esc(input.client.billingAddress)}</div>` : ''}
    </div>
  </section>
  <table>
    <thead>
      <tr><th>Description</th><th class="amt">Amount</th></tr>
    </thead>
    <tbody>${linesHtml}</tbody>
    <tfoot>
      <tr><td>Subtotal</td><td class="amt">${cents(input.subtotalCents)}</td></tr>
      ${
        input.processingFeeCents > 0
          ? `<tr><td>Processing fee</td><td class="amt">${cents(input.processingFeeCents)}</td></tr>`
          : ''
      }
      <tr class="total"><td>Total</td><td class="amt">${cents(input.totalCents)}</td></tr>
    </tfoot>
  </table>
  ${input.notes ? `<div class="notes">${esc(input.notes)}</div>` : ''}
</body>
</html>`;
}
