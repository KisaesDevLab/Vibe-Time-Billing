// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// WIP / pre-bill domain helpers.

import type { Cents, IsoDate } from '@vibe/types';

export type AgingBucket = '0-30' | '31-60' | '61-90' | '90+';

/** Days between two ISO dates (asOf - entryDate). */
export function daysBetween(entryDate: IsoDate, asOf: IsoDate): number {
  const a = Date.parse(`${entryDate}T00:00:00Z`);
  const b = Date.parse(`${asOf}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}

export function bucketForAge(days: number): AgingBucket {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

/** Roll a set of (entry_date, amount) tuples into aging buckets. */
export function bucketize(
  rows: { entryDate: IsoDate; amountCents: Cents }[],
  asOf: IsoDate,
): Record<AgingBucket, Cents> {
  const result: Record<AgingBucket, Cents> = {
    '0-30': 0,
    '31-60': 0,
    '61-90': 0,
    '90+': 0,
  };
  for (const r of rows) {
    const days = daysBetween(r.entryDate, asOf);
    result[bucketForAge(days)] += r.amountCents;
  }
  return result;
}

export type EntryAction = 'INCLUDE' | 'DEFER' | 'WRITE_OFF' | 'WRITE_OFF_HELD';

/**
 * Pre-bill batch action applied per entry. Pure function — the API layer
 * persists these via Drizzle.
 */
export function applyEntryAction(args: { action: EntryAction; entryAmountCents: Cents }): {
  batchedAmountCents: Cents;
  carryForwardAmountCents: Cents;
  writtenOffAmountCents: Cents;
} {
  switch (args.action) {
    case 'INCLUDE':
      return {
        batchedAmountCents: args.entryAmountCents,
        carryForwardAmountCents: 0,
        writtenOffAmountCents: 0,
      };
    case 'DEFER':
      return {
        batchedAmountCents: 0,
        carryForwardAmountCents: args.entryAmountCents,
        writtenOffAmountCents: 0,
      };
    case 'WRITE_OFF':
      return {
        batchedAmountCents: 0,
        carryForwardAmountCents: 0,
        writtenOffAmountCents: args.entryAmountCents,
      };
    case 'WRITE_OFF_HELD':
      // The entry is held aside for partner re-evaluation; it stays on
      // WIP (carry-forward) but is also marked as written-off for
      // realization reporting in the current period.
      return {
        batchedAmountCents: 0,
        carryForwardAmountCents: args.entryAmountCents,
        writtenOffAmountCents: args.entryAmountCents,
      };
  }
}
