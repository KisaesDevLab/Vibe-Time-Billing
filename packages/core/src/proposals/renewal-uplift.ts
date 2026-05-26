// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P25 — Renewal uplift calculators.
//
// Three modes the firm picks per engagement:
//   MANUAL_PERCENT       — firm enters a per-engagement percentage
//   REALIZATION_BASED    — pulls prior-period realization; if below
//                          target, uplift = (target - prior) / prior
//                          (e.g. target 100%, prior 80% → +25% uplift)
//   CPI_INDEXED          — applies YoY change in the US BLS
//                          Consumer Price Index for All Urban
//                          Consumers (CPI-U)
//
// All three return basis points (500 = 5%) so the renewals.uplift_bps
// column captures them uniformly. Negative bps means a price cut
// (rare but legal — e.g. CPI deflation, or a manual concession).

export type UpliftMode = 'MANUAL_PERCENT' | 'REALIZATION_BASED' | 'CPI_INDEXED';

export interface UpliftResult {
  upliftBps: number;
  suggestedTotalCents: number;
  // Reason string for the UI tooltip ("CPI-U YoY: +3.2%", "Realization
  // 80% vs target 100% → +25%", etc.).
  reason: string;
  // Optional payload for storage (CPI snapshot, realization detail).
  snapshot?: Record<string, unknown>;
}

// =====================================================================
// MANUAL_PERCENT
// =====================================================================

export function manualPercentUplift(currentTotalCents: number, percentBps: number): UpliftResult {
  const scaled = Math.round((currentTotalCents * (10_000 + percentBps)) / 10_000);
  return {
    upliftBps: percentBps,
    suggestedTotalCents: Math.max(0, scaled),
    reason: `Manual ${(percentBps / 100).toFixed(2)}%`,
  };
}

// =====================================================================
// REALIZATION_BASED
// =====================================================================
//
// `priorBillableCents` is the engagement's billable WIP last period.
// `priorBilledCents` is what was actually invoiced. Realization =
// billed/billable. To bring realization to target, uplift the headline
// by (target/realization - 1).

export interface RealizationInput {
  currentTotalCents: number;
  priorBilledCents: number;
  priorBillableCents: number;
  // Default 100 (= 100%). Stored as basis points: 10000 = 100%.
  targetRealizationBps?: number;
}

export function realizationBasedUplift(input: RealizationInput): UpliftResult {
  const target = input.targetRealizationBps ?? 10_000;
  if (input.priorBilledCents <= 0 || input.priorBillableCents <= 0) {
    return {
      upliftBps: 0,
      suggestedTotalCents: input.currentTotalCents,
      reason: 'No prior data — uplift held at 0',
    };
  }
  // Realization in bps: billed / billable * 10000.
  const realizationBps = Math.round((input.priorBilledCents * 10_000) / input.priorBillableCents);
  if (realizationBps >= target) {
    return {
      upliftBps: 0,
      suggestedTotalCents: input.currentTotalCents,
      reason: `Realization ${(realizationBps / 100).toFixed(1)}% already meets target ${(target / 100).toFixed(1)}%`,
    };
  }
  // upliftBps = (target / realization - 1) * 10000
  // = (target - realization) * 10000 / realization
  const upliftBps = Math.round(((target - realizationBps) * 10_000) / realizationBps);
  const suggested = Math.round((input.currentTotalCents * (10_000 + upliftBps)) / 10_000);
  return {
    upliftBps,
    suggestedTotalCents: Math.max(0, suggested),
    reason: `Realization ${(realizationBps / 100).toFixed(1)}% vs target ${(target / 100).toFixed(1)}% → +${(upliftBps / 100).toFixed(2)}%`,
    snapshot: {
      priorBilledCents: input.priorBilledCents,
      priorBillableCents: input.priorBillableCents,
      realizationBps,
      targetRealizationBps: target,
    },
  };
}

// =====================================================================
// CPI_INDEXED
// =====================================================================
//
// Caller fetches CPI-U values (current vs 12 months ago) from BLS and
// supplies them here. The fetcher itself lives in
// apps/api/src/renewals/bls-cpi.ts so the pure calculator stays
// dependency-free.

export interface CpiSnapshot {
  series: 'CUUR0000SA0'; // CPI-U all items, not seasonally adjusted
  currentValue: number;
  currentPeriod: string; // YYYY-MM
  priorValue: number;
  priorPeriod: string; // YYYY-MM (12 months earlier)
  fetchedAt: string;
}

export function cpiIndexedUplift(currentTotalCents: number, cpi: CpiSnapshot): UpliftResult {
  if (cpi.priorValue <= 0) {
    return {
      upliftBps: 0,
      suggestedTotalCents: currentTotalCents,
      reason: 'CPI prior value missing — uplift held at 0',
    };
  }
  // yoyDelta = (current - prior) / prior; expressed in bps.
  const upliftBps = Math.round(((cpi.currentValue - cpi.priorValue) * 10_000) / cpi.priorValue);
  const suggested = Math.round((currentTotalCents * (10_000 + upliftBps)) / 10_000);
  return {
    upliftBps,
    suggestedTotalCents: Math.max(0, suggested),
    reason: `CPI-U YoY ${(upliftBps / 100).toFixed(2)}% (${cpi.priorPeriod} → ${cpi.currentPeriod})`,
    snapshot: cpi as unknown as Record<string, unknown>,
  };
}
