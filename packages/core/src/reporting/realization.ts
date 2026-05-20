// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Realization rollup. Aggregates `adjustment_allocation` rows up to
// per-timekeeper, per-engagement, per-client, per-firm levels.
//
// Inputs come from the SQL materialized view; this function pure-rolls
// the math so consumers (API + reports + AI narrative) share semantics.

import type { Cents, Uuid } from '@vibe/types';

export interface AllocationRow {
  appUserId: Uuid;
  engagementId: Uuid;
  clientId: Uuid;
  originalValueCents: Cents;
  adjustedValueCents: Cents;
}

export interface RealizationRollup {
  originalValueCents: Cents;
  adjustedValueCents: Cents;
  realizationPct: number; // 0-1 (e.g. 0.89 = 89%)
}

export function rollup(rows: AllocationRow[]): RealizationRollup {
  const original = rows.reduce((s, r) => s + r.originalValueCents, 0);
  const adjusted = rows.reduce((s, r) => s + r.adjustedValueCents, 0);
  return {
    originalValueCents: original,
    adjustedValueCents: adjusted,
    realizationPct: original === 0 ? 0 : adjusted / original,
  };
}

export function rollupBy(
  rows: AllocationRow[],
  key: (r: AllocationRow) => string,
): Map<string, RealizationRollup> {
  const groups = new Map<string, AllocationRow[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }
  const out = new Map<string, RealizationRollup>();
  for (const [k, arr] of groups) out.set(k, rollup(arr));
  return out;
}

/** Effective rate = billed / hours. Caller provides total hours. */
export function effectiveRate(args: { billedCents: Cents; hours: number }): Cents {
  if (args.hours <= 0) return 0;
  return Math.round(args.billedCents / args.hours);
}

/** Utilization = billable hours / available hours. Returns 0..1. */
export function utilization(args: { billableHours: number; availableHours: number }): number {
  if (args.availableHours <= 0) return 0;
  return Math.min(1, Math.max(0, args.billableHours / args.availableHours));
}
