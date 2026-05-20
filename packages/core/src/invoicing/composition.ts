// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Invoice line-item composition. Pure functions that produce the line
// items for a given billing batch / engagement state.

import type { Cents } from '@vibe/types';

export type LineItemKind =
  | 'TIME_AGGREGATE'
  | 'FIXED_FEE'
  | 'MILESTONE'
  | 'RECURRING_FEE'
  | 'EXPENSE'
  | 'PROCESSING_FEE'
  | 'CUSTOM';

export interface LineItem {
  kind: LineItemKind;
  description: string;
  amountCents: Cents;
  meta?: Record<string, unknown>;
}

export interface InvoiceTotals {
  subtotalCents: Cents;
  processingFeeCents: Cents;
  totalCents: Cents;
}

export function computeTotals(lines: LineItem[]): InvoiceTotals {
  let subtotal = 0;
  let processingFee = 0;
  for (const l of lines) {
    if (l.kind === 'PROCESSING_FEE') processingFee += l.amountCents;
    else subtotal += l.amountCents;
  }
  return {
    subtotalCents: subtotal,
    processingFeeCents: processingFee,
    totalCents: subtotal + processingFee,
  };
}

/** Late-fee accrual: simple per-period flat or percent. */
export function computeLateFee(args: {
  invoiceTotalCents: Cents;
  policy:
    | { kind: 'NONE' }
    | { kind: 'FLAT'; amountCents: Cents }
    | { kind: 'PERCENT'; pct: number };
  daysOverdue: number;
}): Cents {
  if (args.daysOverdue <= 0) return 0;
  switch (args.policy.kind) {
    case 'NONE':
      return 0;
    case 'FLAT':
      return args.policy.amountCents;
    case 'PERCENT':
      return Math.round(args.invoiceTotalCents * (Math.max(0, args.policy.pct) / 100));
  }
}

/**
 * Compute processing-fee passthrough line. Per Q9, this is engagement-level
 * opt-in; the caller decides whether to attach.
 */
export function processingFeeLine(args: {
  invoiceSubtotalCents: Cents;
  cardRatePct: number;
  cardFlatCents: Cents;
}): LineItem {
  // Stripe-style card rate: pct% + flat cents per charge.
  const amount =
    Math.round(args.invoiceSubtotalCents * (args.cardRatePct / 100)) + args.cardFlatCents;
  return {
    kind: 'PROCESSING_FEE',
    description: 'Payment processing fee',
    amountCents: amount,
  };
}
