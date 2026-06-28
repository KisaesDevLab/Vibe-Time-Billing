// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect } from 'vitest';

import { renderInvoiceHtml } from './templates';

describe('renderInvoiceHtml', () => {
  const input = {
    invoiceNumber: 'INV-2026-00042',
    issueDate: '2026-05-20',
    dueDate: '2026-06-19',
    firm: { name: 'Granite Peak CPAs', address: '123 Main' },
    client: { name: 'Holland Manufacturing LLC' },
    lines: [
      { kind: 'TIME_AGGREGATE' as const, description: 'Hours — Tax', amountCents: 100000 },
      { kind: 'FIXED_FEE' as const, description: 'Tax prep flat', amountCents: 50000 },
    ],
    subtotalCents: 150000,
    processingFeeCents: 0,
    totalCents: 150000,
  };

  it('renders complete HTML', () => {
    const html = renderInvoiceHtml(input);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('INV-2026-00042');
    expect(html).toContain('Holland Manufacturing LLC');
    expect(html).toContain('$1,000.00'); // hours line
    expect(html).toContain('$1,500.00'); // total
  });

  it('escapes HTML in client name (XSS hardening)', () => {
    const html = renderInvoiceHtml({
      ...input,
      client: { name: '<script>alert(1)</script>' },
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits processing-fee row when zero', () => {
    const html = renderInvoiceHtml(input);
    expect(html).not.toContain('Processing fee');
  });

  it('includes processing-fee row when non-zero', () => {
    const html = renderInvoiceHtml({
      ...input,
      processingFeeCents: 4500,
      totalCents: 154500,
    });
    expect(html).toContain('Processing fee');
  });
});
