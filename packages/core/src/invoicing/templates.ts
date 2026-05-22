// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// HTML templates for invoice PDFs. Plain text-interpolation — Q28 says
// no Markdown / WYSIWYG, just variable substitution. The Puppeteer
// renderer (apps/api/src/pdf/render.ts) takes the HTML output of these
// functions and prints to A4 PDF.

import type { Cents, IsoDate } from '@vibe/types';

import type { LineItem } from './composition';

export type InvoiceTemplateStyle = 'modern' | 'classic' | 'minimal';

export interface InvoiceTemplateInput {
  invoiceNumber: string;
  issueDate: IsoDate;
  dueDate: IsoDate;
  firm: { name: string; logoUrl?: string | null; address?: string | null };
  branding?: {
    accentColor?: string | null;
    supportEmail?: string | null;
    supportPhone?: string | null;
    footerHtml?: string | null;
  } | null;
  client: { name: string; billingAddress?: string | null };
  lines: LineItem[];
  subtotalCents: Cents;
  /** v2 — per-engagement surcharge total (sum of SURCHARGE lines). */
  surchargeCents?: Cents;
  /** v2 — sales/GET/GRT tax total (sum of SALES_TAX lines). */
  taxCents?: Cents;
  processingFeeCents: Cents;
  totalCents: Cents;
  notes?: string | null;
  // Phase 13 #6 — firm-style template picker. Defaults to 'modern'.
  style?: InvoiceTemplateStyle;
}

const cents = (c: Cents): string => `$${(c / 100).toFixed(2)}`;
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderInvoiceHtml(input: InvoiceTemplateInput): string {
  const style = input.style ?? 'modern';
  if (style === 'classic') return renderClassic(input);
  if (style === 'minimal') return renderMinimal(input);
  return renderModern(input);
}

/**
 * Find a label from the first matching line item, or fall back. The
 * generator stamps the engagement-configured label in the line's
 * description (e.g. "Technology fee" / "GET (4.25%)"), so the footer
 * row reuses it verbatim.
 */
function labelFor(input: InvoiceTemplateInput, kind: LineItem['kind'], fallback: string): string {
  return input.lines.find((l) => l.kind === kind)?.description ?? fallback;
}

function buildCommon(input: InvoiceTemplateInput): {
  linesHtml: string;
  accent: string;
  logo: string;
  supportLine: string;
} {
  // Surcharge + tax + processing-fee lines render in the totals footer,
  // not in the line items table. Filter them out here so they don't
  // appear twice on the PDF.
  const itemLines = input.lines.filter(
    (l) => l.kind !== 'SURCHARGE' && l.kind !== 'SALES_TAX' && l.kind !== 'PROCESSING_FEE',
  );
  const linesHtml = itemLines
    .map(
      (l) => `<tr><td>${esc(l.description)}</td><td class="amt">${cents(l.amountCents)}</td></tr>`,
    )
    .join('');
  const accent =
    input.branding?.accentColor &&
    /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(input.branding.accentColor)
      ? input.branding.accentColor
      : '#111';
  const logo = input.firm.logoUrl
    ? `<img src="${esc(input.firm.logoUrl)}" alt="" style="max-height: 48px; max-width: 220px; margin-bottom: 8px;" />`
    : '';
  const supportLine = [input.branding?.supportEmail, input.branding?.supportPhone]
    .filter(Boolean)
    .join(' · ');
  return { linesHtml, accent, logo, supportLine };
}

function renderModern(input: InvoiceTemplateInput): string {
  const { linesHtml, accent, logo, supportLine } = buildCommon(input);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice ${esc(input.invoiceNumber)}</title>
  <style>
    body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #111; margin: 32px; }
    header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; border-bottom: 2px solid ${accent}; padding-bottom: 16px; }
    header h1 { font-size: 22px; margin: 0; color: ${accent}; }
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
    .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #666; }
  </style>
</head>
<body>
  <header>
    <div>
      ${logo}
      <h1>${esc(input.firm.name)}</h1>
      ${input.firm.address ? `<div>${esc(input.firm.address)}</div>` : ''}
      ${supportLine ? `<div style="font-size: 11px; color: #666; margin-top: 4px;">${esc(supportLine)}</div>` : ''}
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
        (input.surchargeCents ?? 0) > 0
          ? `<tr><td>${esc(labelFor(input, 'SURCHARGE', 'Surcharge'))}</td><td class="amt">${cents(input.surchargeCents ?? 0)}</td></tr>`
          : ''
      }
      ${
        (input.taxCents ?? 0) > 0
          ? `<tr><td>${esc(labelFor(input, 'SALES_TAX', 'Sales tax'))}</td><td class="amt">${cents(input.taxCents ?? 0)}</td></tr>`
          : ''
      }
      ${
        input.processingFeeCents > 0
          ? `<tr><td>Processing fee</td><td class="amt">${cents(input.processingFeeCents)}</td></tr>`
          : ''
      }
      <tr class="total"><td>Total</td><td class="amt">${cents(input.totalCents)}</td></tr>
    </tfoot>
  </table>
  ${input.notes ? `<div class="notes">${esc(input.notes)}</div>` : ''}
  ${input.branding?.footerHtml ? `<div class="footer">${input.branding.footerHtml}</div>` : ''}
</body>
</html>`;
}

// Classic — formal letter-style layout: firm at top center, Invoice
// title centered below, parties stacked left-aligned, sober serif body.
function renderClassic(input: InvoiceTemplateInput): string {
  const { linesHtml, accent, logo, supportLine } = buildCommon(input);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice ${esc(input.invoiceNumber)}</title>
  <style>
    body { font: 14px Georgia, "Times New Roman", serif; color: #1a1a1a; margin: 48px; }
    .firm-block { text-align: center; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid #888; }
    .firm-block h1 { font-size: 24px; margin: 8px 0 4px; letter-spacing: 0.02em; }
    .firm-block .meta { font-size: 12px; color: #444; }
    .doc-title { text-align: center; font-size: 18px; letter-spacing: 0.16em; margin: 0 0 24px; text-transform: uppercase; }
    .meta-row { display: flex; justify-content: space-between; margin-bottom: 24px; font-size: 13px; color: #333; }
    .parties { margin-bottom: 24px; }
    .parties h3 { font-size: 12px; text-transform: uppercase; color: ${accent}; margin: 0 0 4px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { padding: 10px 6px; border-bottom: 1px solid #d4d4d4; vertical-align: top; font-size: 13px; }
    th { text-align: left; font-weight: 600; border-bottom: 2px solid #333; }
    td.amt, th.amt { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { border-bottom: none; padding-top: 10px; }
    tfoot tr.total td { border-top: 2px solid #333; font-weight: 700; font-size: 15px; }
    .notes { margin-top: 24px; font-style: italic; font-size: 12px; color: #555; white-space: pre-wrap; }
    .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #ccc; font-size: 11px; color: #666; text-align: center; }
  </style>
</head>
<body>
  <div class="firm-block">
    ${logo}
    <h1>${esc(input.firm.name)}</h1>
    ${input.firm.address ? `<div class="meta">${esc(input.firm.address)}</div>` : ''}
    ${supportLine ? `<div class="meta">${esc(supportLine)}</div>` : ''}
  </div>
  <div class="doc-title">Invoice</div>
  <div class="meta-row">
    <div><strong>Invoice #${esc(input.invoiceNumber)}</strong></div>
    <div>Issued ${esc(input.issueDate)} · Due ${esc(input.dueDate)}</div>
  </div>
  <div class="parties">
    <h3>Bill to</h3>
    <div>${esc(input.client.name)}</div>
    ${input.client.billingAddress ? `<div>${esc(input.client.billingAddress)}</div>` : ''}
  </div>
  <table>
    <thead>
      <tr><th>Description</th><th class="amt">Amount</th></tr>
    </thead>
    <tbody>${linesHtml}</tbody>
    <tfoot>
      <tr><td>Subtotal</td><td class="amt">${cents(input.subtotalCents)}</td></tr>
      ${
        (input.surchargeCents ?? 0) > 0
          ? `<tr><td>${esc(labelFor(input, 'SURCHARGE', 'Surcharge'))}</td><td class="amt">${cents(input.surchargeCents ?? 0)}</td></tr>`
          : ''
      }
      ${
        (input.taxCents ?? 0) > 0
          ? `<tr><td>${esc(labelFor(input, 'SALES_TAX', 'Sales tax'))}</td><td class="amt">${cents(input.taxCents ?? 0)}</td></tr>`
          : ''
      }
      ${
        input.processingFeeCents > 0
          ? `<tr><td>Processing fee</td><td class="amt">${cents(input.processingFeeCents)}</td></tr>`
          : ''
      }
      <tr class="total"><td>Total Due</td><td class="amt">${cents(input.totalCents)}</td></tr>
    </tfoot>
  </table>
  ${input.notes ? `<div class="notes">${esc(input.notes)}</div>` : ''}
  ${input.branding?.footerHtml ? `<div class="footer">${input.branding.footerHtml}</div>` : ''}
</body>
</html>`;
}

// Minimal — single column, large total, no accent rules. The visual
// debt for firms that don't want logo or footer treatments.
function renderMinimal(input: InvoiceTemplateInput): string {
  const { linesHtml, accent, logo } = buildCommon(input);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice ${esc(input.invoiceNumber)}</title>
  <style>
    body { font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; margin: 48px; line-height: 1.5; max-width: 640px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .meta { font-size: 12px; color: #666; margin-bottom: 24px; }
    .total-callout { font-size: 30px; font-weight: 600; color: ${accent}; margin: 24px 0 4px; }
    .total-caption { font-size: 12px; text-transform: uppercase; color: #888; letter-spacing: 0.08em; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    td { padding: 6px 0; vertical-align: top; }
    td.amt { text-align: right; font-variant-numeric: tabular-nums; color: #444; }
    hr { border: 0; border-top: 1px solid #eee; margin: 16px 0; }
    .notes { font-size: 12px; color: #555; white-space: pre-wrap; }
  </style>
</head>
<body>
  ${logo}
  <h1>${esc(input.firm.name)}</h1>
  <div class="meta">
    Invoice #${esc(input.invoiceNumber)} · Issued ${esc(input.issueDate)} · Due ${esc(input.dueDate)}
  </div>
  <div class="total-callout">${cents(input.totalCents)}</div>
  <div class="total-caption">Total due — ${esc(input.client.name)}</div>
  <hr />
  <table>
    <tbody>${linesHtml}</tbody>
    <tfoot>
      <tr><td>Subtotal</td><td class="amt">${cents(input.subtotalCents)}</td></tr>
      ${
        (input.surchargeCents ?? 0) > 0
          ? `<tr><td>${esc(labelFor(input, 'SURCHARGE', 'Surcharge'))}</td><td class="amt">${cents(input.surchargeCents ?? 0)}</td></tr>`
          : ''
      }
      ${
        (input.taxCents ?? 0) > 0
          ? `<tr><td>${esc(labelFor(input, 'SALES_TAX', 'Sales tax'))}</td><td class="amt">${cents(input.taxCents ?? 0)}</td></tr>`
          : ''
      }
    </tfoot>
  </table>
  ${
    input.processingFeeCents > 0
      ? `<div class="meta">Includes $${(input.processingFeeCents / 100).toFixed(2)} processing fee</div>`
      : ''
  }
  ${input.notes ? `<div class="notes">${esc(input.notes)}</div>` : ''}
  ${input.branding?.footerHtml ? `<hr /><div class="meta">${input.branding.footerHtml}</div>` : ''}
</body>
</html>`;
}
