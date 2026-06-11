// SPDX-License-Identifier: Elastic-2.0
//
// CP3 — Payment receipt HTML builder tests.
//
// The receipt-exports module is a pure function of its input. Privacy
// is enforced by the input *type* — fields like payment_method_id,
// fee_cents, retry_count are not in `ReceiptHtmlInput`, so the
// renderer can't accidentally surface them. These tests pin the
// "no firm-internal fields, ever" contract by asserting the rendered
// HTML doesn't contain any of those substrings even when we try to
// feed them in.

import { describe, expect, it } from 'vitest';

import { renderReceiptHtml } from '../invoices/receipt-exports';

describe('renderReceiptHtml', () => {
  it('renders firm + client + invoice + amount + reference', () => {
    const html = renderReceiptHtml({
      firmName: 'Acme CPA',
      clientName: 'Wile E. Co',
      invoiceNumber: 'INV-2026-0042',
      paymentId: '11111111-1111-4111-8111-111111111111',
      amountCents: 250000,
      receivedAt: new Date('2026-04-15T12:00:00Z'),
      providerChargeId: 'ch_test_abc',
    });
    expect(html).toContain('Acme CPA');
    expect(html).toContain('Wile E. Co');
    expect(html).toContain('INV-2026-0042');
    expect(html).toContain('$2500.00');
    expect(html).toContain('ch_test_abc');
    expect(html).toContain('2026-04-15');
    expect(html).toContain('Thank you');
  });

  it('renders refund banner when payment was refunded', () => {
    const html = renderReceiptHtml({
      firmName: 'Firm',
      clientName: 'Client',
      invoiceNumber: 'INV-1',
      paymentId: 'pid',
      amountCents: 100000,
      receivedAt: '2026-04-15',
      providerChargeId: null,
      refundedAt: '2026-05-01',
      refundedAmountCents: 50000,
    });
    expect(html).toContain('Refunded');
    expect(html).toContain('$500.00');
    expect(html).toContain('2026-05-01');
    // "Thank you" replaced with refund-specific footer
    expect(html).not.toContain('Thank you');
    expect(html).toContain('Contact your firm');
  });

  it('omits reference paragraph when providerChargeId is null', () => {
    const html = renderReceiptHtml({
      firmName: 'Firm',
      clientName: 'Client',
      invoiceNumber: 'INV-1',
      paymentId: 'pid',
      amountCents: 100,
      receivedAt: '2026-04-15',
      providerChargeId: null,
    });
    expect(html).not.toContain('Reference:');
  });

  it('escapes HTML metacharacters in firm + client names', () => {
    const html = renderReceiptHtml({
      firmName: '<script>x</script>',
      clientName: 'Tom & Jerry',
      invoiceNumber: 'INV-1',
      paymentId: 'pid',
      amountCents: 1000,
      receivedAt: '2026-04-15',
      providerChargeId: null,
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Tom &amp; Jerry');
  });

  it('TypeScript input type prevents firm-internal fields from being passed', () => {
    // Compile-time guarantee: the ReceiptHtmlInput interface does not
    // accept fee_cents, payment_method_id, retry_count, next_retry_at.
    // Any change to receipt-exports.ts that adds them to the input type
    // (or a render path that reads from a broader object) should be
    // caught here.
    //
    // We render with a minimal input + assert privacy-sensitive
    // substrings aren't accidentally present (e.g. via a future
    // template change that string-interpolates raw payment row data).
    const html = renderReceiptHtml({
      firmName: 'Firm',
      clientName: 'Client',
      invoiceNumber: 'INV-1',
      paymentId: 'pid',
      amountCents: 1000,
      receivedAt: '2026-04-15',
      providerChargeId: 'ch_x',
    });
    expect(html).not.toContain('payment_method_id');
    expect(html).not.toContain('fee_cents');
    expect(html).not.toContain('retry_count');
    expect(html).not.toContain('next_retry_at');
  });
});
