// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, it, expect } from 'vitest';

import { computeLateFee, computeTotals, formatInvoiceNumber, processingFeeLine } from './';

describe('invoice numbering', () => {
  it('formats with prefix, year and sequence', () => {
    expect(
      formatInvoiceNumber({
        config: { prefix: 'INV', yearPart: 'FOUR_DIGIT' },
        sequence: 42,
        issueDate: '2026-05-20',
      }),
    ).toBe('INV-2026-00042');
  });

  it('includes office code when configured', () => {
    expect(
      formatInvoiceNumber({
        config: { prefix: 'INV', yearPart: 'TWO_DIGIT', officeCode: 'DEN' },
        sequence: 7,
        issueDate: '2026-05-20',
      }),
    ).toBe('INV-DEN-26-00007');
  });

  it('omits year when configured NONE', () => {
    expect(
      formatInvoiceNumber({
        config: { prefix: 'INV', yearPart: 'NONE', pad: 4 },
        sequence: 100,
        issueDate: '2026-05-20',
      }),
    ).toBe('INV-0100');
  });
});

describe('invoice totals', () => {
  it('separates processing fee from subtotal', () => {
    const totals = computeTotals([
      { kind: 'TIME_AGGREGATE', description: 'Hours', amountCents: 100000 },
      { kind: 'FIXED_FEE', description: 'Tax prep', amountCents: 50000 },
      { kind: 'PROCESSING_FEE', description: 'CC fee', amountCents: 4500 },
    ]);
    expect(totals).toEqual({
      subtotalCents: 150000,
      surchargeCents: 0,
      taxCents: 0,
      processingFeeCents: 4500,
      totalCents: 154500,
    });
  });

  it('bucketizes surcharge + sales tax + processing fee separately', () => {
    const totals = computeTotals([
      { kind: 'TIME_AGGREGATE', description: 'Hours', amountCents: 100000 },
      { kind: 'SURCHARGE', description: 'Technology fee', amountCents: 3000 },
      { kind: 'SALES_TAX', description: 'GET (4.25%)', amountCents: 4378 },
      { kind: 'PROCESSING_FEE', description: 'CC fee', amountCents: 4500 },
    ]);
    expect(totals).toEqual({
      subtotalCents: 100000,
      surchargeCents: 3000,
      taxCents: 4378,
      processingFeeCents: 4500,
      totalCents: 111878,
    });
  });
});

describe('late fee', () => {
  it('returns zero if not overdue', () => {
    expect(
      computeLateFee({
        invoiceTotalCents: 100000,
        policy: { kind: 'PERCENT', pct: 1.5 },
        daysOverdue: 0,
      }),
    ).toBe(0);
  });
  it('flat policy', () => {
    expect(
      computeLateFee({
        invoiceTotalCents: 100000,
        policy: { kind: 'FLAT', amountCents: 2500 },
        daysOverdue: 10,
      }),
    ).toBe(2500);
  });
  it('percent policy', () => {
    expect(
      computeLateFee({
        invoiceTotalCents: 100000,
        policy: { kind: 'PERCENT', pct: 1.5 },
        daysOverdue: 10,
      }),
    ).toBe(1500);
  });
});

describe('processing fee passthrough', () => {
  it('computes Stripe-style pct + flat', () => {
    const line = processingFeeLine({
      invoiceSubtotalCents: 100000, // $1,000
      cardRatePct: 2.9,
      cardFlatCents: 30,
    });
    expect(line.kind).toBe('PROCESSING_FEE');
    expect(line.amountCents).toBe(2930); // 100000*0.029 + 30
  });
});
