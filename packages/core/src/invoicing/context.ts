// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Builds the namespaced context object the invoice template-engine
// resolves tokens against, and the catalog of those tokens for the
// admin variable picker / docs. This is the single place the invoice
// render context is assembled — staff PDF, portal, pay-link and email
// all feed `InvoiceTemplateInput` through here.

import type { Cents } from '@vibe/types';

import { formatDateUS as fmtDate, formatMoneyCents } from './format';
import type { LineItem, LineItemKind } from './composition';
import type { InvoiceTemplateInput } from './templates';
import type { TemplateContext } from './template-engine';

const cents = (c: Cents): string => formatMoneyCents(c);

/** Label from the first matching line item, or a fallback. */
function labelFor(lines: LineItem[], kind: LineItemKind, fallback: string): string {
  return lines.find((l) => l.kind === kind)?.description ?? fallback;
}

function formatMailingAddress(c: InvoiceTemplateInput['client']): string {
  const out: string[] = [];
  if (c.mailingStreet1) out.push(c.mailingStreet1);
  if (c.mailingStreet2) out.push(c.mailingStreet2);
  const cityState = [c.mailingCity, c.mailingState].filter(Boolean).join(', ');
  const lastLine = [cityState, c.mailingPostal].filter(Boolean).join('  ');
  if (lastLine) out.push(lastLine);
  if (c.mailingCountry) out.push(c.mailingCountry);
  if (out.length === 0 && c.billingAddress) out.push(c.billingAddress);
  return out.join('\n');
}

function validAccent(color: string | null | undefined): string {
  return color && /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(color) ? color : '#1a1a1a';
}

/** Optional safe-HTML extras only the document surfaces supply. */
export interface InvoiceContextExtras {
  /** Past-due / payment-terms notice (raw HTML, rendered via {{{ dunning }}}). */
  dunning?: string | null;
  /** Time-entry breakdown table for full-detail mode (raw HTML). */
  timeDetailHtml?: string | null;
  /** No-login pay-by-link URL (drives invoice.pay_url / invoice.pay_qr). */
  payUrl?: string | null;
  /** QR code (data: URI) encoding the pay URL — drives invoice.pay_qr. */
  payQrDataUri?: string | null;
}

export function buildInvoiceTemplateContext(
  input: InvoiceTemplateInput,
  extras: InvoiceContextExtras = {},
): TemplateContext {
  const itemLines = input.lines.filter(
    (l) => l.kind !== 'SURCHARGE' && l.kind !== 'SALES_TAX' && l.kind !== 'PROCESSING_FEE',
  );

  const surcharges: Array<{ label: string; amount: string }> = [];
  if ((input.surchargeCents ?? 0) !== 0) {
    surcharges.push({
      label: labelFor(input.lines, 'SURCHARGE', 'Surcharge'),
      amount: cents(input.surchargeCents ?? 0),
    });
  }
  if ((input.taxCents ?? 0) !== 0) {
    surcharges.push({
      label: labelFor(input.lines, 'SALES_TAX', 'Sales tax'),
      amount: cents(input.taxCents ?? 0),
    });
  }
  if (input.processingFeeCents > 0) {
    surcharges.push({ label: 'Processing fee', amount: cents(input.processingFeeCents) });
  }

  const paidCents = input.paidCents ?? 0;
  const balanceDue = input.totalCents - paidCents;
  const dueTerms =
    input.dueDate && input.dueDate > input.issueDate
      ? `Due ${fmtDate(input.dueDate)}`
      : 'Due Upon Receipt';

  return {
    firm: {
      name: input.firm.name,
      logo_url: input.firm.logoUrl ?? '',
      address: input.firm.address ?? '',
      phone: input.branding?.supportPhone ?? '',
      email: input.branding?.supportEmail ?? '',
      fax: input.branding?.supportFax ?? '',
      web: input.branding?.supportWeb ?? '',
      accent_color: validAccent(input.branding?.accentColor),
    },
    client: {
      name: input.client.name,
      address: formatMailingAddress(input.client),
      external_id: input.client.externalId ?? '',
      mailing_street1: input.client.mailingStreet1 ?? '',
      mailing_street2: input.client.mailingStreet2 ?? '',
      mailing_city: input.client.mailingCity ?? '',
      mailing_state: input.client.mailingState ?? '',
      mailing_postal: input.client.mailingPostal ?? '',
      mailing_country: input.client.mailingCountry ?? '',
    },
    invoice: {
      number: input.invoiceNumber,
      issue_date: fmtDate(input.issueDate),
      due_date: fmtDate(input.dueDate),
      due_terms: dueTerms,
      reference: input.reference ?? input.invoiceNumber,
      engagement_name: input.engagementName ?? '',
      service_intro: 'For professional service rendered as follows:',
      billing_name: input.engagementName ?? '',
      subtotal: cents(input.subtotalCents),
      subtotal_label: 'Billed Time and Expenses',
      surcharge_total: cents(input.surchargeCents ?? 0),
      tax_total: cents(input.taxCents ?? 0),
      processing_fee: cents(input.processingFeeCents),
      total: cents(input.totalCents),
      total_label: 'Total Current Charges',
      paid: cents(paidCents),
      balance_due: cents(balanceDue),
      status: input.status ?? '',
      notes: input.notes ?? '',
      // No-login pay-by-link + QR (populated when the rendering surface
      // supplies them; empty otherwise so {{#if}} blocks collapse).
      pay_url: extras.payUrl ?? '',
      pay_qr_src: extras.payQrDataUri ?? '',
      pay_qr: extras.payQrDataUri
        ? `<img src="${extras.payQrDataUri}" alt="Scan to pay online" width="140" height="140" />`
        : '',
    },
    line_items: itemLines.map((l) => ({
      description: l.description,
      amount: cents(l.amountCents),
      quantity: l.meta && typeof l.meta['quantity'] === 'number' ? String(l.meta['quantity']) : '',
      rate:
        l.meta && typeof l.meta['rateCents'] === 'number'
          ? cents(l.meta['rateCents'] as Cents)
          : '',
      kind: l.kind,
    })),
    surcharges,
    // Safe-HTML fields — emit with {{{ ... }}} in the template.
    dunning: extras.dunning ?? '',
    invoice_footer: input.branding?.footerHtml ?? '',
    time_detail_html: extras.timeDetailHtml ?? '',
  };
}

// ---------------------------------------------------------------------------
// Token catalog — drives the editor variable picker and the docs.
// ---------------------------------------------------------------------------

export interface InvoiceTokenEntry {
  token: string;
  scope: 'firm' | 'client' | 'invoice' | 'line_items' | 'surcharges' | 'safe_html';
  description: string;
  /** true for {{{ raw }}} HTML fields. */
  raw?: boolean;
}

export const INVOICE_TEMPLATE_TOKENS: InvoiceTokenEntry[] = [
  { token: 'firm.name', scope: 'firm', description: 'Firm / business display name' },
  { token: 'firm.logo_url', scope: 'firm', description: 'Firm logo image URL' },
  { token: 'firm.address', scope: 'firm', description: 'Firm address (multi-line)' },
  { token: 'firm.phone', scope: 'firm', description: 'Support phone number' },
  { token: 'firm.email', scope: 'firm', description: 'Support email address' },
  { token: 'firm.fax', scope: 'firm', description: 'Support fax number' },
  { token: 'firm.web', scope: 'firm', description: 'Firm website' },
  { token: 'firm.accent_color', scope: 'firm', description: 'Brand accent color (hex)' },

  { token: 'client.name', scope: 'client', description: 'Client name' },
  { token: 'client.address', scope: 'client', description: 'Formatted mailing address block' },
  { token: 'client.external_id', scope: 'client', description: 'Client external ID ("ID:")' },
  { token: 'client.mailing_street1', scope: 'client', description: 'Mailing street line 1' },
  { token: 'client.mailing_street2', scope: 'client', description: 'Mailing street line 2' },
  { token: 'client.mailing_city', scope: 'client', description: 'Mailing city' },
  { token: 'client.mailing_state', scope: 'client', description: 'Mailing state' },
  { token: 'client.mailing_postal', scope: 'client', description: 'Mailing postal code' },
  { token: 'client.mailing_country', scope: 'client', description: 'Mailing country' },

  { token: 'invoice.number', scope: 'invoice', description: 'Invoice number' },
  { token: 'invoice.issue_date', scope: 'invoice', description: 'Issue date' },
  { token: 'invoice.due_date', scope: 'invoice', description: 'Due date' },
  {
    token: 'invoice.due_terms',
    scope: 'invoice',
    description: 'Due label (e.g. "Due Upon Receipt")',
  },
  {
    token: 'invoice.reference',
    scope: 'invoice',
    description: 'Reference (engagement code / number)',
  },
  { token: 'invoice.engagement_name', scope: 'invoice', description: 'Primary engagement name' },
  { token: 'invoice.service_intro', scope: 'invoice', description: 'Intro line above charges' },
  {
    token: 'invoice.billing_name',
    scope: 'invoice',
    description: 'Billing name shown under intro',
  },
  { token: 'invoice.subtotal', scope: 'invoice', description: 'Subtotal (formatted)' },
  { token: 'invoice.subtotal_label', scope: 'invoice', description: 'Subtotal row label' },
  {
    token: 'invoice.surcharge_total',
    scope: 'invoice',
    description: 'Surcharge total (formatted)',
  },
  { token: 'invoice.tax_total', scope: 'invoice', description: 'Sales tax total (formatted)' },
  { token: 'invoice.processing_fee', scope: 'invoice', description: 'Processing fee (formatted)' },
  { token: 'invoice.total', scope: 'invoice', description: 'Grand total (formatted)' },
  { token: 'invoice.total_label', scope: 'invoice', description: 'Total row label' },
  { token: 'invoice.paid', scope: 'invoice', description: 'Amount paid (formatted)' },
  { token: 'invoice.balance_due', scope: 'invoice', description: 'Balance due (formatted)' },
  { token: 'invoice.status', scope: 'invoice', description: 'Invoice status' },
  { token: 'invoice.notes', scope: 'invoice', description: 'Invoice notes / memo' },
  { token: 'invoice.pay_url', scope: 'invoice', description: 'No-login pay-by-link URL' },
  {
    token: 'invoice.pay_qr_src',
    scope: 'invoice',
    description: 'QR image data URI (for a custom <img src>)',
  },

  {
    token: 'this.description',
    scope: 'line_items',
    description: 'Line item description (inside #each line_items)',
  },
  {
    token: 'this.amount',
    scope: 'line_items',
    description: 'Line item amount (inside #each line_items)',
  },
  { token: 'this.quantity', scope: 'line_items', description: 'Line item quantity (if any)' },
  { token: 'this.rate', scope: 'line_items', description: 'Line item rate (if any)' },
  { token: 'this.kind', scope: 'line_items', description: 'Line item kind' },

  {
    token: 'this.label',
    scope: 'surcharges',
    description: 'Surcharge/tax/fee label (inside #each surcharges)',
  },
  {
    token: 'this.amount',
    scope: 'surcharges',
    description: 'Surcharge/tax/fee amount (inside #each surcharges)',
  },

  {
    token: 'invoice.pay_qr',
    scope: 'safe_html',
    description: 'QR <img> linking to the no-login pay page',
    raw: true,
  },
  {
    token: 'dunning',
    scope: 'safe_html',
    description: 'Past-due / terms notice (HTML)',
    raw: true,
  },
  {
    token: 'invoice_footer',
    scope: 'safe_html',
    description: 'Remit-to / EIN / terms footer (HTML)',
    raw: true,
  },
  {
    token: 'time_detail_html',
    scope: 'safe_html',
    description: 'Time-entry detail table, full-detail mode (HTML)',
    raw: true,
  },
];
