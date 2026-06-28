// SPDX-License-Identifier: Elastic-2.0
import { describe, expect, it } from 'vitest';

import { buildInvoiceTemplateContext } from './context';
import { composeInvoiceHtml } from './template-engine';
import { DEFAULT_INVOICE_BODY_HTML, DEFAULT_INVOICE_CSS } from './default-invoice-template';
import { renderInvoiceDocument, type InvoiceTemplateInput } from './templates';

const baseInput: InvoiceTemplateInput = {
  invoiceNumber: '2000166095',
  issueDate: '2025-12-10',
  dueDate: '2025-12-10',
  firm: { name: 'The CPA Group, PC', logoUrl: null, address: '217 Fourth St\nMonett, MO 65708' },
  branding: {
    accentColor: '#123456',
    supportEmail: 'a@b.com',
    supportPhone: '555',
    supportFax: null,
    supportWeb: 'cpa2web.com',
    footerHtml: '<strong>Remit to PO Box 68</strong>',
  },
  client: {
    name: 'Timothy P & Barbara Dieckhoff',
    externalId: 'DIEC6130',
    mailingStreet1: '109 Main St',
    mailingCity: 'Monett',
    mailingState: 'MO',
    mailingPostal: '65708',
  },
  lines: [
    { kind: 'TIME_AGGREGATE', description: 'Compilation of financials', amountCents: 35000 },
    { kind: 'SURCHARGE', description: 'Technology Surcharge', amountCents: 1400 },
    { kind: 'SALES_TAX', description: 'Sales Tax', amountCents: 2871 },
  ],
  subtotalCents: 35000,
  surchargeCents: 1400,
  taxCents: 2871,
  processingFeeCents: 0,
  totalCents: 39271,
  notes: 'Thank you',
  paidCents: 10000,
};

describe('buildInvoiceTemplateContext', () => {
  it('maps namespaced scopes, line items and surcharges', () => {
    const ctx = buildInvoiceTemplateContext(baseInput, { dunning: 'Past due' });
    expect((ctx.firm as Record<string, unknown>).accent_color).toBe('#123456');
    expect((ctx.client as Record<string, unknown>).external_id).toBe('DIEC6130');
    expect((ctx.client as Record<string, unknown>).address).toContain('Monett, MO  65708');
    expect((ctx.invoice as Record<string, unknown>).total).toBe('$392.71');
    expect((ctx.invoice as Record<string, unknown>).balance_due).toBe('$292.71');
    // SURCHARGE / SALES_TAX excluded from line_items, surfaced in surcharges.
    expect((ctx.line_items as unknown[]).length).toBe(1);
    expect(ctx.surcharges).toEqual([
      { label: 'Technology Surcharge', amount: '$14.00' },
      { label: 'Sales Tax', amount: '$28.71' },
    ]);
    expect(ctx.dunning).toBe('Past due');
    expect(ctx.invoice_footer).toBe('<strong>Remit to PO Box 68</strong>');
  });

  it('exposes pay URL + QR tokens when supplied, empty otherwise', () => {
    const withQr = buildInvoiceTemplateContext(baseInput, {
      payUrl: 'https://pay.example/pay/tok',
      payQrDataUri: 'data:image/png;base64,AAAA',
    });
    const inv = withQr.invoice as Record<string, unknown>;
    expect(inv.pay_url).toBe('https://pay.example/pay/tok');
    expect(inv.pay_qr_src).toBe('data:image/png;base64,AAAA');
    expect(inv.pay_qr).toContain('<img src="data:image/png;base64,AAAA"');

    const noQr = buildInvoiceTemplateContext(baseInput);
    expect((noQr.invoice as Record<string, unknown>).pay_qr).toBe('');
    expect((noQr.invoice as Record<string, unknown>).pay_url).toBe('');
  });

  it('falls back to a safe accent color when invalid', () => {
    const ctx = buildInvoiceTemplateContext({
      ...baseInput,
      branding: { ...baseInput.branding, accentColor: 'not-a-color' },
    });
    expect((ctx.firm as Record<string, unknown>).accent_color).toBe('#1a1a1a');
  });
});

describe('renderInvoiceDocument', () => {
  it('renders the default letterhead template end-to-end', () => {
    const html = renderInvoiceDocument(
      baseInput,
      { bodyHtml: DEFAULT_INVOICE_BODY_HTML, css: DEFAULT_INVOICE_CSS, builtinStyle: null },
      { dunning: 'Your account is past due.' },
    );
    expect(html).toContain('The CPA Group, PC');
    expect(html).toContain('DIEC6130');
    expect(html).toContain('Compilation of financials');
    expect(html).toContain('Technology Surcharge');
    expect(html).toContain('$392.71');
    expect(html).toContain('Your account is past due.');
    expect(html).toContain('--accent: #123456');
    // Escaped client name with ampersand.
    expect(html).toContain('Timothy P &amp; Barbara Dieckhoff');
  });

  it('falls back to a builtin style when builtinStyle is set', () => {
    const html = renderInvoiceDocument(baseInput, {
      bodyHtml: DEFAULT_INVOICE_BODY_HTML,
      css: DEFAULT_INVOICE_CSS,
      builtinStyle: 'minimal',
    });
    // minimal renderer has the large total callout class; letterhead does not.
    expect(html).toContain('total-callout');
  });

  it('uses the default builtin renderer when no template is provided', () => {
    const html = renderInvoiceDocument(baseInput, null);
    expect(html).toContain('<!doctype html>');
  });

  it('matches a hand-built compose call', () => {
    const ctx = buildInvoiceTemplateContext(baseInput);
    const html = composeInvoiceHtml(DEFAULT_INVOICE_BODY_HTML, DEFAULT_INVOICE_CSS, ctx);
    expect(html).toContain('Total Current Charges');
  });
});
