// SPDX-License-Identifier: Elastic-2.0
//
// HTML templates for invoice PDFs. Plain text-interpolation — Q28 says
// no Markdown / WYSIWYG, just variable substitution. The Puppeteer
// renderer (apps/api/src/pdf/render.ts) takes the HTML output of these
// functions and prints to A4 PDF.

import type { Cents, IsoDate } from '@vibe/types';

import type { LineItem } from './composition';
import { buildInvoiceTemplateContext, type InvoiceContextExtras } from './context';
import { formatDateUS, formatMoneyCents } from './format';
import { buildStatementTemplateContext } from './statement-context';
import { composeInvoiceHtml } from './template-engine';

export type InvoiceTemplateStyle = 'modern' | 'classic' | 'minimal';

/**
 * A firm's saved invoice document template. When `builtinStyle` is set
 * (or there is no custom body), rendering falls back to the legacy
 * modern/classic/minimal renderers; otherwise the editable HTML+CSS is
 * rendered through the template engine.
 */
export interface InvoiceTemplateDef {
  bodyHtml: string | null;
  css: string | null;
  builtinStyle?: InvoiceTemplateStyle | null;
}

export interface InvoiceTemplateInput {
  invoiceNumber: string;
  issueDate: IsoDate;
  dueDate: IsoDate;
  firm: { name: string; logoUrl?: string | null; address?: string | null };
  branding?: {
    accentColor?: string | null;
    supportEmail?: string | null;
    supportPhone?: string | null;
    supportFax?: string | null;
    supportWeb?: string | null;
    footerHtml?: string | null;
  } | null;
  client: {
    name: string;
    billingAddress?: string | null;
    /** 0050 — structured mailing address; renders as a recipient block. */
    mailingStreet1?: string | null;
    mailingStreet2?: string | null;
    mailingCity?: string | null;
    mailingState?: string | null;
    mailingPostal?: string | null;
    mailingCountry?: string | null;
    /** 0052 — client external ID, shown as "ID: XYZ" beside the address. */
    externalId?: string | null;
  };
  lines: LineItem[];
  subtotalCents: Cents;
  /** v2 — per-engagement surcharge total (sum of SURCHARGE lines). */
  surchargeCents?: Cents;
  /** v2 — sales/GET/GRT tax total (sum of SALES_TAX lines). */
  taxCents?: Cents;
  processingFeeCents: Cents;
  totalCents: Cents;
  notes?: string | null;
  /** 0052 — short reference (engagement code / period) shown in the
   *  "For professional service rendered..." row. Defaults to invoiceNumber. */
  reference?: string | null;
  /** 0052 — top-line intro shown under the engagement name (e.g. the
   *  engagement long-description). */
  engagementName?: string | null;
  // Phase 13 #6 — firm-style template picker. Defaults to 'modern'.
  style?: InvoiceTemplateStyle;
  /** Amount paid to date (drives invoice.paid / invoice.balance_due tokens). */
  paidCents?: Cents;
  /** Invoice status (DRAFT/SENT/PAID/…) — exposed as invoice.status. */
  status?: string;
}

const cents = (c: Cents): string => formatMoneyCents(c);
const fmtDate = (iso: string | null | undefined): string => formatDateUS(iso);
const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export function renderInvoiceHtml(input: InvoiceTemplateInput): string {
  const style = input.style ?? 'modern';
  if (style === 'classic') return renderClassic(input);
  if (style === 'minimal') return renderMinimal(input);
  return renderModern(input);
}

/**
 * Central invoice document renderer used by every surface (staff PDF,
 * portal, pay-link, email). Renders the firm's editable HTML+CSS
 * template through the engine, or falls back to a builtin style.
 *
 *   - custom template (bodyHtml present, no builtinStyle) → engine path
 *   - builtinStyle set, or no custom body → legacy modern/classic/minimal
 *
 * `extras.timeDetailHtml` is emitted raw via {{{ time_detail_html }}} on
 * the engine path; on the legacy path it is appended to notes to
 * preserve the existing full-detail behavior.
 */
export function renderInvoiceDocument(
  input: InvoiceTemplateInput,
  template: InvoiceTemplateDef | null,
  extras: InvoiceContextExtras = {},
): string {
  const useCustom = !!template && !template.builtinStyle && !!template.bodyHtml;
  if (useCustom) {
    const ctx = buildInvoiceTemplateContext(input, extras);
    return composeInvoiceHtml(template!.bodyHtml!, template!.css ?? '', ctx);
  }
  const notes = extras.timeDetailHtml
    ? `${input.notes ?? ''}\n\n${extras.timeDetailHtml}`
    : input.notes;
  return renderInvoiceHtml({
    ...input,
    notes,
    style: template?.builtinStyle ?? input.style,
  });
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

function formatMailingAddress(c: InvoiceTemplateInput['client']): string[] {
  const out: string[] = [];
  if (c.mailingStreet1) out.push(c.mailingStreet1);
  if (c.mailingStreet2) out.push(c.mailingStreet2);
  const cityState = [c.mailingCity, c.mailingState].filter(Boolean).join(', ');
  const lastLine = [cityState, c.mailingPostal].filter(Boolean).join('  ');
  if (lastLine) out.push(lastLine);
  if (c.mailingCountry) out.push(c.mailingCountry);
  if (out.length === 0 && c.billingAddress) out.push(c.billingAddress);
  return out;
}

// Professional letterhead invoice — letter-size, single-page-friendly.
// Top banner with logo + contact pills, address strip in firm accent,
// recipient block on the left and invoice meta on the right, itemized
// lines, totals stacked bottom-right, AR-terms footer.
function renderModern(input: InvoiceTemplateInput): string {
  const { accent, logo } = buildCommon(input);
  // Indented line-item rendering specific to this template — uses
  // .item so the CSS picks up the left-pad + tabular align.
  const linesHtml = input.lines
    .filter((l) => l.kind !== 'SURCHARGE' && l.kind !== 'SALES_TAX' && l.kind !== 'PROCESSING_FEE')
    .map(
      (l) =>
        `<tr class="item"><td>${esc(l.description)}</td><td class="amt">${cents(l.amountCents)}</td></tr>`,
    )
    .join('');
  const addressLines = formatMailingAddress(input.client);
  const phone = input.branding?.supportPhone ?? '';
  const fax = input.branding?.supportFax ?? '';
  const web = input.branding?.supportWeb ?? '';
  const email = input.branding?.supportEmail ?? '';
  const firmAddr = input.firm.address ?? '';
  const reference = input.reference ?? input.invoiceNumber;
  const dueLabel =
    input.dueDate && input.dueDate <= input.issueDate
      ? 'Due Upon Receipt'
      : `Due ${fmtDate(input.dueDate)}`;

  // Contact-pills strip on the right of the header. Each pill is one
  // medium-tinted accent rectangle with a label icon (unicode glyphs to
  // avoid external font/image dependencies).
  const pills: Array<{ icon: string; label: string }> = [];
  if (phone) pills.push({ icon: '☎', label: phone });
  if (fax) pills.push({ icon: '✉', label: fax });
  if (email && !fax) pills.push({ icon: '✉', label: email });
  if (web) pills.push({ icon: '⟗', label: web });
  const pillsHtml = pills
    .map(
      (p) =>
        `<div class="pill"><span class="ic">${esc(p.icon)}</span><span>${esc(p.label)}</span></div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Invoice ${esc(input.invoiceNumber)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    body {
      font: 11pt "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: #111;
      margin: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .top-band { height: 6px; background: #000; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding: 18px 0 0;
    }
    .logo-block { display: flex; flex-direction: column; }
    .logo-block img { max-height: 70px; max-width: 320px; object-fit: contain; }
    .logo-block h1 {
      font-size: 28pt;
      margin: 0;
      letter-spacing: -0.02em;
      color: #111;
      font-weight: 800;
    }
    .logo-block .tagline {
      font-size: 10pt;
      letter-spacing: 0.18em;
      color: #444;
      margin-top: 4px;
      text-transform: uppercase;
    }
    .pills { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
    .pill {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 12px;
      background: ${accent};
      color: #fff;
      font-size: 10.5pt;
      font-weight: 600;
      border-radius: 1px;
    }
    .pill .ic { width: 16px; text-align: center; font-size: 11pt; }
    .firm-strip {
      margin-top: 6px;
      padding: 5px 14px;
      background: ${accent};
      color: #fff;
      font-size: 10pt;
      font-weight: 500;
      text-align: right;
    }
    .firm-strip .pin { margin-right: 6px; }

    .recipient {
      display: grid;
      grid-template-columns: 3.2fr 2fr;
      gap: 24px;
      margin-top: 32px;
    }
    .recipient .addr {
      border: 1px solid #888;
      padding: 12px 14px;
      min-height: 110px;
      font-size: 11pt;
      line-height: 1.45;
    }
    .recipient .meta { font-size: 11pt; }
    .recipient .meta .row { display: flex; gap: 8px; margin-bottom: 4px; }
    .recipient .meta .row .lbl { color: #555; min-width: 70px; }
    .recipient .meta .id-block {
      border: 1px solid #888;
      padding: 8px 12px;
      margin-bottom: 12px;
    }
    .recipient .meta .inv-block {
      border: 1px solid #888;
      padding: 8px 12px;
    }
    .recipient .meta .inv-block .due {
      margin-top: 4px;
      font-weight: 600;
    }

    .intro-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin: 22px 0 0;
      padding: 6px 0;
      border-top: 1px solid #888;
      border-bottom: 1px solid #888;
      font-size: 11pt;
      font-weight: 600;
    }
    .intro-row .ref { font-weight: 500; color: #333; }

    .lines { width: 100%; border-collapse: collapse; margin-top: 14px; }
    .lines .group-head { font-weight: 700; padding-top: 12px; }
    .lines .item td { padding: 4px 0 4px 24px; vertical-align: top; }
    .lines .item td.amt {
      text-align: right;
      font-variant-numeric: tabular-nums;
      padding-right: 0;
      padding-left: 12px;
      min-width: 110px;
    }
    .lines .item.subtotal td {
      padding-left: 24px;
      padding-top: 8px;
      border-top: 1px solid #d0d0d0;
    }

    .totals-wrap {
      display: flex;
      justify-content: flex-end;
      margin-top: 24px;
    }
    .totals {
      min-width: 320px;
      border-collapse: collapse;
      font-size: 11pt;
    }
    .totals td { padding: 4px 12px; }
    .totals td.lbl { color: #222; }
    .totals td.amt {
      text-align: right;
      font-variant-numeric: tabular-nums;
      border-bottom: 1px solid #888;
      min-width: 130px;
    }
    .totals tr.grand td {
      padding-top: 8px;
      border-top: 1px solid #000;
      font-weight: 700;
      font-size: 12pt;
      border-bottom: 2px solid #000;
    }

    .terms {
      margin-top: 48px;
      padding-top: 12px;
      border-top: 1px solid #ccc;
      font-size: 9pt;
      font-style: italic;
      color: #555;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="top-band"></div>
  <div class="header">
    <div class="logo-block">
      ${logo || `<h1>${esc(input.firm.name)}</h1>`}
    </div>
    <div class="pills">${pillsHtml}</div>
  </div>
  ${firmAddr ? `<div class="firm-strip"><span class="pin">📍</span>${esc(firmAddr)}</div>` : ''}

  <div class="recipient">
    <div class="addr">
      <div style="font-weight:600;">${esc(input.client.name)}</div>
      ${addressLines.map((l) => `<div>${esc(l)}</div>`).join('')}
    </div>
    <div class="meta">
      <div class="id-block">
        <div class="row"><span class="lbl">ID:</span><span>${esc(input.client.externalId ?? '—')}</span></div>
      </div>
      <div class="inv-block">
        <div class="row"><span class="lbl">Invoice:</span><span>${esc(input.invoiceNumber)}</span></div>
        <div class="row"><span class="lbl">Date:</span><span>${esc(fmtDate(input.issueDate))}</span></div>
        <div class="due">${esc(dueLabel)}</div>
      </div>
    </div>
  </div>

  <div class="intro-row">
    <div>For professional service rendered as follows:</div>
    <div class="ref">Reference: ${esc(reference)}</div>
  </div>

  <table class="lines">
    <tbody>
      <tr class="group-head">
        <td>${esc(input.client.name)}</td>
        <td class="amt"></td>
      </tr>
      ${linesHtml}
    </tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals">
      <tbody>
        <tr>
          <td class="lbl">Billed Time and Expenses</td>
          <td class="amt">${cents(input.subtotalCents)}</td>
        </tr>
        ${
          (input.surchargeCents ?? 0) !== 0
            ? `<tr><td class="lbl">${esc(labelFor(input, 'SURCHARGE', 'Surcharge'))}</td><td class="amt">${cents(input.surchargeCents ?? 0)}</td></tr>`
            : ''
        }
        ${
          (input.taxCents ?? 0) !== 0
            ? `<tr><td class="lbl">${esc(labelFor(input, 'SALES_TAX', 'Sales tax'))}</td><td class="amt">${cents(input.taxCents ?? 0)}</td></tr>`
            : ''
        }
        ${
          input.processingFeeCents > 0
            ? `<tr><td class="lbl">Processing fee</td><td class="amt">${cents(input.processingFeeCents)}</td></tr>`
            : ''
        }
        <tr class="grand">
          <td class="lbl">Total Current Charges</td>
          <td class="amt">${cents(input.totalCents)}</td>
        </tr>
      </tbody>
    </table>
  </div>

  ${input.notes ? `<div class="terms">${esc(input.notes)}</div>` : ''}
  ${input.branding?.footerHtml ? `<div class="terms">${input.branding.footerHtml}</div>` : ''}
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
    <div>Issued ${esc(fmtDate(input.issueDate))} · Due ${esc(fmtDate(input.dueDate))}</div>
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
        (input.surchargeCents ?? 0) !== 0
          ? `<tr><td>${esc(labelFor(input, 'SURCHARGE', 'Surcharge'))}</td><td class="amt">${cents(input.surchargeCents ?? 0)}</td></tr>`
          : ''
      }
      ${
        (input.taxCents ?? 0) !== 0
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
    Invoice #${esc(input.invoiceNumber)} · Issued ${esc(fmtDate(input.issueDate))} · Due ${esc(fmtDate(input.dueDate))}
  </div>
  <div class="total-callout">${cents(input.totalCents)}</div>
  <div class="total-caption">Total due — ${esc(input.client.name)}</div>
  <hr />
  <table>
    <tbody>${linesHtml}</tbody>
    <tfoot>
      <tr><td>Subtotal</td><td class="amt">${cents(input.subtotalCents)}</td></tr>
      ${
        (input.surchargeCents ?? 0) !== 0
          ? `<tr><td>${esc(labelFor(input, 'SURCHARGE', 'Surcharge'))}</td><td class="amt">${cents(input.surchargeCents ?? 0)}</td></tr>`
          : ''
      }
      ${
        (input.taxCents ?? 0) !== 0
          ? `<tr><td>${esc(labelFor(input, 'SALES_TAX', 'Sales tax'))}</td><td class="amt">${cents(input.taxCents ?? 0)}</td></tr>`
          : ''
      }
    </tfoot>
  </table>
  ${
    input.processingFeeCents > 0
      ? `<div class="meta">Includes ${cents(input.processingFeeCents)} processing fee</div>`
      : ''
  }
  ${input.notes ? `<div class="notes">${esc(input.notes)}</div>` : ''}
  ${input.branding?.footerHtml ? `<hr /><div class="meta">${input.branding.footerHtml}</div>` : ''}
</body>
</html>`;
}

// =====================================================================
// 0054 — Statement of Account
//
// Per-client statement rendering. Reuses the same letterhead pieces
// (top band, logo, contact pills, accent address strip) as the modern
// invoice template so a firm's branding is consistent across all
// outbound documents.
// =====================================================================

export interface StatementLine {
  /** Display date (entryDate of the invoice or payment, ISO). */
  date: IsoDate;
  /** Free-text label (e.g. "Invoice", "Payment"). */
  type: string;
  /** Reference (invoice number, payment id). */
  reference: string;
  /** Charge amount, positive cents. Omit on payment rows. */
  debitCents?: Cents;
  /** Payment amount, positive cents. Omit on invoice rows. */
  creditCents?: Cents;
  /** Running balance AFTER this row, signed cents. */
  balanceCents: Cents;
}

export interface StatementAgingBuckets {
  d_0_30: Cents;
  d_31_60: Cents;
  d_61_90: Cents;
  d_91_120: Cents;
  d_121_plus: Cents;
}

export interface StatementTemplateInput {
  statementDate: IsoDate;
  firm: { name: string; logoUrl?: string | null; address?: string | null };
  branding?: {
    accentColor?: string | null;
    supportEmail?: string | null;
    supportPhone?: string | null;
    supportFax?: string | null;
    supportWeb?: string | null;
    footerHtml?: string | null;
  } | null;
  client: {
    name: string;
    externalId?: string | null;
    mailingStreet1?: string | null;
    mailingStreet2?: string | null;
    mailingCity?: string | null;
    mailingState?: string | null;
    mailingPostal?: string | null;
    mailingCountry?: string | null;
    billingAddress?: string | null;
  };
  lines: StatementLine[];
  totalAmountDueCents: Cents;
  aging: StatementAgingBuckets;
  /** Optional banner under the table, e.g. suspension policy notice. */
  policyNotice?: string | null;
  // ---- date-range "account activity" mode (optional) ----
  /** 'outstanding' (default) or 'activity'. */
  mode?: 'outstanding' | 'activity';
  periodStart?: IsoDate | null;
  periodEnd?: IsoDate | null;
  openingBalanceCents?: Cents;
  chargesCents?: Cents;
  paymentsCents?: Cents;
  closingBalanceCents?: Cents;
}

/** A firm's saved statement document template (mirrors InvoiceTemplateDef). */
export interface StatementTemplateDef {
  bodyHtml: string | null;
  css: string | null;
  /** When set, render with the legacy builtin instead of the custom body. */
  builtinStyle?: string | null;
}

/**
 * Central statement document renderer used by every surface (single,
 * bulk-generate, bulk-email). Custom template (bodyHtml present, no
 * builtinStyle) → engine path; else legacy renderStatementHtml.
 */
export function renderStatementDocument(
  input: StatementTemplateInput,
  template: StatementTemplateDef | null,
): string {
  const useCustom = !!template && !template.builtinStyle && !!template.bodyHtml;
  if (useCustom) {
    const ctx = buildStatementTemplateContext(input);
    return composeInvoiceHtml(template!.bodyHtml!, template!.css ?? '', ctx);
  }
  return renderStatementHtml(input);
}

function formatStmtAddress(c: StatementTemplateInput['client']): string[] {
  const out: string[] = [];
  if (c.mailingStreet1) out.push(c.mailingStreet1);
  if (c.mailingStreet2) out.push(c.mailingStreet2);
  const cityState = [c.mailingCity, c.mailingState].filter(Boolean).join(', ');
  const lastLine = [cityState, c.mailingPostal].filter(Boolean).join('  ');
  if (lastLine) out.push(lastLine);
  if (c.mailingCountry) out.push(c.mailingCountry);
  if (out.length === 0 && c.billingAddress) out.push(c.billingAddress);
  return out;
}

export function renderStatementHtml(input: StatementTemplateInput): string {
  const accent =
    input.branding?.accentColor &&
    /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(input.branding.accentColor)
      ? input.branding.accentColor
      : '#111';
  const logo = input.firm.logoUrl
    ? `<img src="${esc(input.firm.logoUrl)}" alt="" style="max-height: 70px; max-width: 320px; object-fit: contain;" />`
    : '';
  const addressLines = formatStmtAddress(input.client);
  const phone = input.branding?.supportPhone ?? '';
  const fax = input.branding?.supportFax ?? '';
  const web = input.branding?.supportWeb ?? '';
  const email = input.branding?.supportEmail ?? '';
  const firmAddr = input.firm.address ?? '';
  const pills: Array<{ icon: string; label: string }> = [];
  if (phone) pills.push({ icon: '☎', label: phone });
  if (fax) pills.push({ icon: '✉', label: fax });
  if (email && !fax) pills.push({ icon: '✉', label: email });
  if (web) pills.push({ icon: '⟗', label: web });
  const pillsHtml = pills
    .map(
      (p) =>
        `<div class="pill"><span class="ic">${esc(p.icon)}</span><span>${esc(p.label)}</span></div>`,
    )
    .join('');

  const linesHtml = input.lines
    .map(
      (l) => `
      <tr>
        <td>${esc(fmtDate(l.date))}</td>
        <td>${esc(l.type)}</td>
        <td>${esc(l.reference)}</td>
        <td class="num">${l.debitCents != null ? cents(l.debitCents) : ''}</td>
        <td class="num">${l.creditCents != null ? cents(l.creditCents) : ''}</td>
        <td class="num">${cents(l.balanceCents)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Statement — ${esc(input.client.name)} — ${esc(input.statementDate)}</title>
  <style>
    @page { size: Letter; margin: 0.5in; }
    body {
      font: 11pt "Helvetica Neue", Helvetica, Arial, sans-serif;
      color: #111;
      margin: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .top-band { height: 6px; background: #000; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      padding: 18px 0 0;
    }
    .logo-block { display: flex; flex-direction: column; }
    .logo-block h1 {
      font-size: 28pt;
      margin: 0;
      letter-spacing: -0.02em;
      color: #111;
      font-weight: 800;
    }
    .pills { display: flex; flex-direction: column; gap: 4px; min-width: 240px; }
    .pill {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 12px;
      background: ${accent};
      color: #fff;
      font-size: 10.5pt;
      font-weight: 600;
      border-radius: 1px;
    }
    .pill .ic { width: 16px; text-align: center; font-size: 11pt; }
    .firm-strip {
      margin-top: 6px;
      padding: 5px 14px;
      background: ${accent};
      color: #fff;
      font-size: 10pt;
      text-align: right;
    }
    .recipient {
      display: grid;
      grid-template-columns: 3fr 2fr;
      gap: 24px;
      margin-top: 32px;
      font-size: 11pt;
      line-height: 1.45;
    }
    .recipient .addr { font-weight: 500; }
    .recipient .addr .name { font-weight: 700; margin-bottom: 2px; }
    .recipient .meta { font-size: 11pt; }
    .recipient .meta .row { display: flex; gap: 8px; margin-bottom: 4px; }
    .recipient .meta .row .lbl { color: #555; min-width: 50px; }
    .doc-title {
      text-align: center;
      font-style: italic;
      font-size: 16pt;
      margin: 32px 0 12px;
      border-top: 1px solid #888;
      padding-top: 14px;
    }
    table.ledger { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
    table.ledger th {
      text-align: left;
      padding: 4px 8px;
      font-weight: 600;
      font-style: italic;
      color: #333;
    }
    table.ledger th.num { text-align: right; }
    table.ledger td { padding: 6px 8px; vertical-align: top; }
    table.ledger td.num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .total-row {
      margin-top: 8px;
      border-top: 1px solid #000;
      padding-top: 6px;
      display: grid;
      grid-template-columns: 90px 1fr auto;
      font-size: 11pt;
    }
    .total-row .date { padding: 0 8px; }
    .total-row .label { font-weight: 600; }
    .total-row .amt {
      border-bottom: 2px solid #000;
      padding: 0 8px 4px;
      min-width: 120px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-weight: 700;
    }
    .policy {
      margin-top: 48px;
      text-align: center;
      font-weight: 700;
      font-size: 11pt;
    }
    .aging {
      margin-top: 20px;
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      border-top: 1px solid #000;
      padding-top: 8px;
      font-size: 10.5pt;
    }
    .aging .bucket { text-align: center; }
    .aging .bucket .lbl {
      text-decoration: underline;
      margin-bottom: 4px;
      font-weight: 500;
    }
    .aging .bucket .amt { font-variant-numeric: tabular-nums; }
    .aging .bucket.total .amt { font-weight: 700; }
    .terms {
      margin-top: 36px;
      padding-top: 12px;
      border-top: 1px solid #ccc;
      font-size: 9pt;
      font-style: italic;
      color: #555;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="top-band"></div>
  <div class="header">
    <div class="logo-block">${logo || `<h1>${esc(input.firm.name)}</h1>`}</div>
    <div class="pills">${pillsHtml}</div>
  </div>
  ${firmAddr ? `<div class="firm-strip">📍 ${esc(firmAddr)}</div>` : ''}

  <div class="recipient">
    <div class="addr">
      <div class="name">${esc(input.client.name)}</div>
      ${addressLines.map((l) => `<div>${esc(l)}</div>`).join('')}
    </div>
    <div class="meta">
      <div class="row"><span class="lbl">Date:</span><span>${esc(fmtDate(input.statementDate))}</span></div>
      <div class="row"><span class="lbl">ID:</span><span>${esc(input.client.externalId ?? '—')}</span></div>
      <div class="row" style="font-weight:600; margin-top:4px;"><span>${esc(input.client.name)}</span></div>
    </div>
  </div>

  <div class="doc-title">Statement of Account</div>

  <table class="ledger">
    <thead>
      <tr>
        <th>Date</th>
        <th>Type</th>
        <th>Reference</th>
        <th class="num">Debit</th>
        <th class="num">Credit</th>
        <th class="num">Balance</th>
      </tr>
    </thead>
    <tbody>${linesHtml}</tbody>
  </table>

  <div class="total-row">
    <div class="date">${esc(fmtDate(input.statementDate))}</div>
    <div class="label">Total Amount Due</div>
    <div class="amt">${cents(input.totalAmountDueCents)}</div>
  </div>

  ${input.policyNotice ? `<div class="policy">${esc(input.policyNotice)}</div>` : ''}

  <div class="aging">
    <div class="bucket"><div class="lbl">0-30 Days</div><div class="amt">${cents(input.aging.d_0_30)}</div></div>
    <div class="bucket"><div class="lbl">31-60 Days</div><div class="amt">${cents(input.aging.d_31_60)}</div></div>
    <div class="bucket"><div class="lbl">61-90 Days</div><div class="amt">${cents(input.aging.d_61_90)}</div></div>
    <div class="bucket"><div class="lbl">91-120 Days</div><div class="amt">${cents(input.aging.d_91_120)}</div></div>
    <div class="bucket"><div class="lbl">121+ Days</div><div class="amt">${cents(input.aging.d_121_plus)}</div></div>
    <div class="bucket total"><div class="lbl">Total</div><div class="amt">${cents(input.totalAmountDueCents)}</div></div>
  </div>

  ${input.branding?.footerHtml ? `<div class="terms">${input.branding.footerHtml}</div>` : ''}
</body>
</html>`;
}

/** Combine multiple statement HTMLs into one document with page breaks
 *  between them, so Puppeteer can produce a single print-ready PDF
 *  containing all selected client statements. */
export function combineStatementsHtml(htmls: string[]): string {
  // Extract <body>...</body> from each rendered statement and stitch
  // together inside one shell with the same @page rule. This avoids
  // nested <html> documents that would break PDF page sizing.
  const bodies = htmls.map((h, i) => {
    const m = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const inner = m ? m[1] : h;
    const styleM = h.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    return {
      style: i === 0 && styleM ? styleM[1] : null,
      body: inner,
    };
  });
  const styleBlock = bodies[0]?.style ?? '';
  const pages = bodies
    .map(
      (b, i) =>
        `<div class="statement-page" ${i < bodies.length - 1 ? 'style="page-break-after: always;"' : ''}>${b.body}</div>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Statements — combined</title>
  <style>${styleBlock}</style>
</head>
<body>${pages}</body>
</html>`;
}
