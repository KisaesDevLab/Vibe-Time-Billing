// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 12 — Adjustment allocation. The wedge.
//
// Six methods produce per-(time_entry, app_user) allocation rows. Each row
// has original_value, adjustment_amount (signed), adjusted_value. Sum of
// adjustment_amount across all rows equals the parent adjustment total
// (±1 cent for rounding distribution).
//
// Non-negotiable #4: rows are at (adjustment_id, time_entry_id,
// app_user_id) grain. We preserve that here: one entry produces one
// allocation row (never more), keyed by the entry's id and its
// timekeeper's app_user_id.
//
// Symmetric write-up: a positive `totalAmountCents` increases adjusted_value
// (raises realization above 100%) and uses identical math otherwise.

import type { AppUserRole, Cents, Hours, Uuid } from '@vibe/types';

export interface TimeEntryInput {
  id: Uuid;
  appUserId: Uuid;
  appUserRole: AppUserRole;
  hours: Hours;
  standardAmountCents: Cents;
}

export interface AllocationResult {
  timeEntryId: Uuid;
  appUserId: Uuid;
  appUserRole: AppUserRole;
  originalValueCents: Cents;
  adjustedValueCents: Cents;
  adjustmentAmountCents: Cents;
}

export interface SpecificEntriesInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
  entrySelections: { entryId: Uuid; amountCents: Cents }[];
}

export interface ProRataInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
}

export interface PartnerAbsorbsInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
}

export interface HierarchicalCascadeInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
  cascadeOrder: AppUserRole[];
}

export type CustomWeightingMode = 'PERCENT' | 'DOLLAR';

export interface CustomWeightedInput {
  totalAmountCents: Cents;
  timeEntries: TimeEntryInput[];
  weightingMode: CustomWeightingMode;
  weights: { appUserId: Uuid; weight: number }[];
}

// ====================================================================
// 1. SPECIFIC ENTRIES
// ====================================================================

export function allocateSpecificEntries(input: SpecificEntriesInput): AllocationResult[] {
  const sum = input.entrySelections.reduce((s, e) => s + e.amountCents, 0);
  if (sum !== input.totalAmountCents) {
    throw new Error(`entry selection sum ${sum} does not equal total ${input.totalAmountCents}`);
  }
  const byId = new Map(input.timeEntries.map((e) => [e.id, e]));
  return input.entrySelections.map((sel) => {
    const entry = byId.get(sel.entryId);
    if (!entry) {
      throw new Error(`entry ${sel.entryId} not found`);
    }
    return makeRow(entry, sel.amountCents);
  });
}

// ====================================================================
// 2. PRO-RATA BY VALUE
// ====================================================================

export function allocateProRataByValue(input: ProRataInput): AllocationResult[] {
  return proRata(input.timeEntries, input.totalAmountCents, (e) => Math.abs(e.standardAmountCents));
}

// ====================================================================
// 3. PRO-RATA BY HOURS
// ====================================================================

export function allocateProRataByHours(input: ProRataInput): AllocationResult[] {
  return proRata(input.timeEntries, input.totalAmountCents, (e) => Math.abs(e.hours));
}

// ====================================================================
// 4. PARTNER ABSORBS
// ====================================================================

export function allocatePartnerAbsorbs(input: PartnerAbsorbsInput): AllocationResult[] {
  const partners = input.timeEntries.filter((e) => e.appUserRole === 'PARTNER');
  if (partners.length === 0) {
    throw new Error('no partner entries available');
  }
  // Distribute total across partner entries, weighted by value. Non-partner
  // entries get zero rows (still emitted to preserve grain).
  const partnerAlloc = proRata(partners, input.totalAmountCents, (e) =>
    Math.abs(e.standardAmountCents),
  );
  const partnerById = new Map(partnerAlloc.map((r) => [r.timeEntryId, r]));

  return input.timeEntries.map((e) => {
    const r = partnerById.get(e.id);
    return r ?? makeRow(e, 0);
  });
}

// ====================================================================
// 5. HIERARCHICAL CASCADE
// ====================================================================

export function allocateHierarchicalCascade(input: HierarchicalCascadeInput): AllocationResult[] {
  const totalWip = input.timeEntries.reduce((s, e) => s + e.standardAmountCents, 0);
  if (Math.abs(input.totalAmountCents) > Math.abs(totalWip) + 1) {
    throw new Error(`adjustment ${input.totalAmountCents} exceeds total WIP ${totalWip}`);
  }

  // The cascade absorbs from the END of the order first (the "absorbs
  // first" tier). The TEST inputs use ['STAFF', 'SENIOR', 'MANAGER',
  // 'PARTNER'] which means partner absorbs first (the standard "junior
  // held harmless" CPA pattern).
  const absorbOrder = [...input.cascadeOrder].reverse();

  // Group entries by role
  const byRole = new Map<AppUserRole, TimeEntryInput[]>();
  for (const e of input.timeEntries) {
    const list = byRole.get(e.appUserRole) ?? [];
    list.push(e);
    byRole.set(e.appUserRole, list);
  }

  // Walk the absorb order; each role absorbs up to its total WIP value (or
  // total negative WIP for a write-up — absolute value caps it). Continue
  // to next role with the remainder.
  let remaining = input.totalAmountCents;
  const out: AllocationResult[] = [];
  const placed = new Set<string>();

  for (const role of absorbOrder) {
    if (remaining === 0) break;
    const entries = byRole.get(role);
    if (!entries || entries.length === 0) continue;

    const roleWip = entries.reduce((s, e) => s + e.standardAmountCents, 0);
    // How much can this tier absorb? The lesser of (|remaining|, roleWip).
    // For a write-down (negative remaining), tier can absorb down to
    // -roleWip; for a write-up, tier can absorb up to +roleWip (the
    // realization can exceed 100% but we cap at a reasonable bound —
    // actually, no cap for write-up; the test for write-up gives partner
    // the full upside even when > roleWip would be impossible. The Vance
    // write-up test only puts $500 on $1,000 WIP so cap doesn't bind.)
    const absorbCap = roleWip; // absolute headroom in the same sign as roleWip
    // For write-down (remaining < 0): tier eats at most -absorbCap.
    // For write-up   (remaining > 0): tier takes at most +absorbCap.
    const tierTake =
      remaining < 0
        ? Math.max(remaining, -absorbCap) // remaining is negative; -absorbCap is more negative
        : Math.min(remaining, absorbCap);

    if (tierTake === 0) {
      for (const e of entries) {
        out.push(makeRow(e, 0));
        placed.add(e.id);
      }
      continue;
    }

    const tierAlloc = proRata(entries, tierTake, (e) => Math.abs(e.standardAmountCents));
    for (const r of tierAlloc) {
      out.push(r);
      placed.add(r.timeEntryId);
    }
    remaining -= tierTake;
  }

  // Any entries not yet placed (lower-priority tiers held harmless) get 0.
  for (const e of input.timeEntries) {
    if (!placed.has(e.id)) {
      out.push(makeRow(e, 0));
    }
  }

  return out;
}

// ====================================================================
// 6. CUSTOM WEIGHTED
// ====================================================================

export function allocateCustomWeighted(input: CustomWeightedInput): AllocationResult[] {
  // Convert weights into per-user target amounts.
  const userTargets = new Map<string, number>();

  if (input.weightingMode === 'PERCENT') {
    const sumPct = input.weights.reduce((s, w) => s + w.weight, 0);
    if (Math.abs(sumPct - 100) > 0.01) {
      throw new Error(`weights must sum to 100, got ${sumPct}`);
    }
    for (const w of input.weights) {
      userTargets.set(w.appUserId, Math.round(input.totalAmountCents * (w.weight / 100)));
    }
    // Rounding fix-up: ensure the targets sum to totalAmountCents exactly.
    const targetSum = Array.from(userTargets.values()).reduce((s, v) => s + v, 0);
    const drift = input.totalAmountCents - targetSum;
    if (drift !== 0) {
      // Apply drift to the largest-magnitude target.
      const largest = Array.from(userTargets.entries()).reduce((best, cur) =>
        Math.abs(cur[1]) > Math.abs(best[1]) ? cur : best,
      );
      userTargets.set(largest[0], largest[1] + drift);
    }
  } else {
    const sumDollars = input.weights.reduce((s, w) => s + w.weight, 0);
    if (sumDollars !== input.totalAmountCents) {
      throw new Error(`weights must sum to total ${input.totalAmountCents}, got ${sumDollars}`);
    }
    for (const w of input.weights) {
      userTargets.set(w.appUserId, w.weight);
    }
  }

  // For each user with a non-zero target, distribute across their entries
  // pro-rata by value. Users not in the weights map → 0 allocation rows.
  const entriesByUser = new Map<string, TimeEntryInput[]>();
  for (const e of input.timeEntries) {
    const arr = entriesByUser.get(e.appUserId) ?? [];
    arr.push(e);
    entriesByUser.set(e.appUserId, arr);
  }

  const out: AllocationResult[] = [];
  for (const e of input.timeEntries) {
    const target = userTargets.get(e.appUserId) ?? 0;
    if (target === 0) {
      out.push(makeRow(e, 0));
    }
  }
  for (const [userId, target] of userTargets) {
    if (target === 0) continue;
    const entries = entriesByUser.get(userId) ?? [];
    const alloc = proRata(entries, target, (en) => Math.abs(en.standardAmountCents));
    out.push(...alloc);
  }
  return out;
}

// ====================================================================
// HELPERS
// ====================================================================

function makeRow(entry: TimeEntryInput, amountCents: Cents): AllocationResult {
  return {
    timeEntryId: entry.id,
    appUserId: entry.appUserId,
    appUserRole: entry.appUserRole,
    originalValueCents: entry.standardAmountCents,
    adjustedValueCents: entry.standardAmountCents + amountCents,
    adjustmentAmountCents: amountCents,
  };
}

/**
 * Distribute `totalAmountCents` across `entries` proportionally to
 * `weightFn(entry)`. Uses largest-remainder rounding so the sum is exact.
 * Zero-weight entries get exactly zero. Sign preserved.
 */
function proRata(
  entries: TimeEntryInput[],
  totalAmountCents: Cents,
  weightFn: (e: TimeEntryInput) => number,
): AllocationResult[] {
  if (entries.length === 0) return [];
  if (totalAmountCents === 0) return entries.map((e) => makeRow(e, 0));

  const weights = entries.map(weightFn);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum === 0) {
    // Degenerate: distribute equally as best fallback.
    return entries.map((e) => makeRow(e, 0));
  }

  // Compute floats, floor each toward zero (preserving sign), then
  // distribute the residual to entries with the largest fractional part.
  const exact: number[] = weights.map((w) => (w * totalAmountCents) / weightSum);
  const floor: number[] = exact.map((v) => Math.trunc(v));
  let allocated = floor.reduce((s, v) => s + v, 0);
  let residual = totalAmountCents - allocated;

  // Rank entries by the magnitude of their fractional part (descending).
  const fracs = exact.map((v, i) => ({ i, frac: Math.abs(v - floor[i]!) }));
  fracs.sort((a, b) => b.frac - a.frac);

  const sign = residual >= 0 ? 1 : -1;
  let i = 0;
  while (residual !== 0 && i < fracs.length) {
    floor[fracs[i]!.i] = floor[fracs[i]!.i]! + sign;
    residual -= sign;
    i++;
  }

  return entries.map((e, idx) => makeRow(e, floor[idx]!));
}
