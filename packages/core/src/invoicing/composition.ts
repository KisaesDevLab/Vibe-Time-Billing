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
  | 'CUSTOM'
  // v2 — per-engagement surcharge + sales-tax lines on the invoice.
  | 'SURCHARGE'
  | 'SALES_TAX'
  // 0066 — retainer-purchase AR invoice line. R3 portal-selection
  // handler issues a new invoice with a single RETAINER line item.
  | 'RETAINER';

export interface LineItem {
  kind: LineItemKind;
  description: string;
  amountCents: Cents;
  meta?: Record<string, unknown>;
}

export interface InvoiceTotals {
  subtotalCents: Cents;
  /** Per-engagement surcharge (firm-defined: technology fee, etc.). */
  surchargeCents: Cents;
  /** Sales/GET/GRT tax on (subtotal + surcharge). */
  taxCents: Cents;
  /** Stripe-style card-processing passthrough (Q9). */
  processingFeeCents: Cents;
  totalCents: Cents;
}

export function computeTotals(lines: LineItem[]): InvoiceTotals {
  let subtotal = 0;
  let surcharge = 0;
  let tax = 0;
  let processingFee = 0;
  for (const l of lines) {
    if (l.kind === 'PROCESSING_FEE') processingFee += l.amountCents;
    else if (l.kind === 'SURCHARGE') surcharge += l.amountCents;
    else if (l.kind === 'SALES_TAX') tax += l.amountCents;
    else subtotal += l.amountCents;
  }
  return {
    subtotalCents: subtotal,
    surchargeCents: surcharge,
    taxCents: tax,
    processingFeeCents: processingFee,
    totalCents: subtotal + surcharge + tax + processingFee,
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

/**
 * Per-engagement surcharge line. Returns `null` when the configured
 * surcharge would resolve to $0 so callers can splat with a falsy
 * filter without checking each branch.
 */
export function surchargeLine(args: {
  subtotalCents: Cents;
  type: 'PERCENT' | 'FLAT_AMOUNT';
  valueBps?: number;
  amountCents?: Cents;
  label: string;
}): LineItem | null {
  let amount = 0;
  if (args.type === 'PERCENT') {
    const bps = args.valueBps ?? 0;
    if (bps <= 0) return null;
    amount = Math.round(args.subtotalCents * (bps / 10_000));
  } else {
    amount = args.amountCents ?? 0;
  }
  if (amount <= 0) return null;
  return {
    kind: 'SURCHARGE',
    description: args.label,
    amountCents: amount,
    meta: { type: args.type, valueBps: args.valueBps ?? null },
  };
}

/**
 * Sales-tax line. Tax base must be precomputed by the caller — typically
 * subtotal + surcharge per the v2 locked decision. Returns null when the
 * rate or base resolves to $0.
 */
export function salesTaxLine(args: {
  taxBaseCents: Cents;
  rateBps: number;
  label: string;
}): LineItem | null {
  if (args.rateBps <= 0 || args.taxBaseCents <= 0) return null;
  const amount = Math.round(args.taxBaseCents * (args.rateBps / 10_000));
  if (amount <= 0) return null;
  const ratePct = (args.rateBps / 100).toFixed(args.rateBps % 100 === 0 ? 0 : 2);
  return {
    kind: 'SALES_TAX',
    description: `${args.label} (${ratePct}%)`,
    amountCents: amount,
    meta: { rateBps: args.rateBps },
  };
}
