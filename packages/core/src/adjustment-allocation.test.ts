// =====================================================================
// packages/core/src/adjustment-allocation.test.ts
//
// Phase 12 — Allocation method correctness test suite.
//
// This is THE highest-correctness-risk surface in the entire build.
// Every allocation method × multiple scenarios. Test sum constraints,
// per-timekeeper grain preservation, and symmetric write-up math.
//
// Reference: CLAUDE.md non-negotiable #4 — per-timekeeper allocation grain.
// Reference: BUILD_PLAN.md Phase 12 acceptance criteria.
//
// Allocation function signatures expected at packages/core/src/adjustment-allocation.ts:
//
//   allocateSpecificEntries(input: SpecificEntriesInput): AllocationResult[]
//   allocateProRataByValue(input: ProRataInput): AllocationResult[]
//   allocateProRataByHours(input: ProRataInput): AllocationResult[]
//   allocatePartnerAbsorbs(input: PartnerAbsorbsInput): AllocationResult[]
//   allocateHierarchicalCascade(input: HierarchicalCascadeInput): AllocationResult[]
//   allocateCustomWeighted(input: CustomWeightedInput): AllocationResult[]
//
// =====================================================================

import { describe, it, expect } from 'vitest';
import {
  allocateSpecificEntries,
  allocateProRataByValue,
  allocateProRataByHours,
  allocatePartnerAbsorbs,
  allocateHierarchicalCascade,
  allocateCustomWeighted,
  type TimeEntryInput,
  type AllocationResult,
} from './adjustment-allocation';

// =====================================================================
// TEST FIXTURES
// =====================================================================

/**
 * Four timekeepers, one entry each — the canonical "Vance" scenario.
 *
 *   Sarah Chen (PARTNER) — 2.0h @ $500/h = $1,000
 *   Mike Davis  (MANAGER) — 4.0h @ $300/h = $1,200
 *   Rachel Kim  (SENIOR)  — 3.0h @ $250/h =   $750
 *   Jenny Park  (STAFF)   — 5.0h @ $200/h = $1,000
 *
 *   Total WIP = $3,950
 */
const VANCE: TimeEntryInput[] = [
  {
    id: 'e-sarah',
    appUserId: 'u-sarah',
    appUserRole: 'PARTNER',
    hours: 2.0,
    standardAmountCents: 100000,
  },
  {
    id: 'e-mike',
    appUserId: 'u-mike',
    appUserRole: 'MANAGER',
    hours: 4.0,
    standardAmountCents: 120000,
  },
  {
    id: 'e-rachel',
    appUserId: 'u-rachel',
    appUserRole: 'SENIOR',
    hours: 3.0,
    standardAmountCents: 75000,
  },
  {
    id: 'e-jenny',
    appUserId: 'u-jenny',
    appUserRole: 'STAFF',
    hours: 5.0,
    standardAmountCents: 100000,
  },
];

/**
 * Same client, multiple entries per timekeeper — tests grain preservation.
 *
 *   Sarah: 2 entries totaling 4.0h / $2,000
 *   Mike:  3 entries totaling 6.0h / $1,800
 */
const MULTI_ENTRY: TimeEntryInput[] = [
  { id: 'e-sarah-1', appUserId: 'u-sarah', appUserRole: 'PARTNER', hours: 2.0, standardAmountCents: 100000 },
  { id: 'e-sarah-2', appUserId: 'u-sarah', appUserRole: 'PARTNER', hours: 2.0, standardAmountCents: 100000 },
  { id: 'e-mike-1',  appUserId: 'u-mike',  appUserRole: 'MANAGER', hours: 2.0, standardAmountCents:  60000 },
  { id: 'e-mike-2',  appUserId: 'u-mike',  appUserRole: 'MANAGER', hours: 2.0, standardAmountCents:  60000 },
  { id: 'e-mike-3',  appUserId: 'u-mike',  appUserRole: 'MANAGER', hours: 2.0, standardAmountCents:  60000 },
];

/**
 * Edge case: single entry.
 */
const SINGLE_ENTRY: TimeEntryInput[] = [
  { id: 'e-only', appUserId: 'u-solo', appUserRole: 'PARTNER', hours: 1.0, standardAmountCents: 50000 },
];

// =====================================================================
// SHARED INVARIANT ASSERTIONS
// =====================================================================

/**
 * Every allocation result must produce a sum equal to the parent total.
 * Allow ±$0.01 (1 cent) tolerance for rounding distribution.
 */
function expectSumEqualsTotal(results: AllocationResult[], totalAmountCents: number): void {
  const sum = results.reduce((acc, r) => acc + r.adjustmentAmountCents, 0);
  expect(Math.abs(sum - totalAmountCents)).toBeLessThanOrEqual(1);
}

/**
 * Every result must have non-empty time_entry_id and app_user_id — the
 * per-timekeeper grain invariant. Sum across (time_entry, user) pairs
 * must equal the parent total.
 */
function expectGrainPreserved(results: AllocationResult[]): void {
  for (const r of results) {
    expect(r.timeEntryId).toBeTruthy();
    expect(r.appUserId).toBeTruthy();
  }
  const grainKeys = new Set(results.map((r) => `${r.timeEntryId}::${r.appUserId}`));
  // No duplicate grain keys
  expect(grainKeys.size).toBe(results.length);
}

/**
 * original_value - adjustment_amount must equal adjusted_value (algebraic invariant).
 * Note: adjustment_amount is signed — negative for write-down, positive for write-up.
 * adjusted_value = original_value + adjustment_amount.
 */
function expectAlgebraConsistent(results: AllocationResult[]): void {
  for (const r of results) {
    expect(r.adjustedValueCents).toBe(r.originalValueCents + r.adjustmentAmountCents);
  }
}

/**
 * Composite assertion: run all three core invariants.
 */
function expectValidAllocation(results: AllocationResult[], totalAmountCents: number): void {
  expectSumEqualsTotal(results, totalAmountCents);
  expectGrainPreserved(results);
  expectAlgebraConsistent(results);
}

// =====================================================================
// METHOD 1: SPECIFIC ENTRIES
// =====================================================================

describe('allocateSpecificEntries', () => {
  it('allocates exactly the amounts the user specified', () => {
    const result = allocateSpecificEntries({
      totalAmountCents: -50000,
      timeEntries: VANCE,
      entrySelections: [
        { entryId: 'e-mike', amountCents: -30000 },
        { entryId: 'e-rachel', amountCents: -20000 },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.timeEntryId === 'e-mike')?.adjustmentAmountCents).toBe(-30000);
    expect(result.find((r) => r.timeEntryId === 'e-rachel')?.adjustmentAmountCents).toBe(-20000);
    expectValidAllocation(result, -50000);
  });

  it('supports symmetric write-up (positive total)', () => {
    const result = allocateSpecificEntries({
      totalAmountCents: 50000,
      timeEntries: VANCE,
      entrySelections: [{ entryId: 'e-sarah', amountCents: 50000 }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.adjustmentAmountCents).toBe(50000);
    // adjusted_value > original_value for write-up
    expect(result[0]!.adjustedValueCents).toBeGreaterThan(result[0]!.originalValueCents);
    expectValidAllocation(result, 50000);
  });

  it('rejects selections whose amounts do not sum to total', () => {
    expect(() =>
      allocateSpecificEntries({
        totalAmountCents: -100000,
        timeEntries: VANCE,
        entrySelections: [{ entryId: 'e-mike', amountCents: -30000 }],
      }),
    ).toThrow(/sum.*total/i);
  });

  it('rejects selections referencing unknown entry ids', () => {
    expect(() =>
      allocateSpecificEntries({
        totalAmountCents: -50000,
        timeEntries: VANCE,
        entrySelections: [{ entryId: 'e-nonexistent', amountCents: -50000 }],
      }),
    ).toThrow(/not found/i);
  });

  it('allows zero adjustment on some selected entries', () => {
    const result = allocateSpecificEntries({
      totalAmountCents: -50000,
      timeEntries: VANCE,
      entrySelections: [
        { entryId: 'e-mike', amountCents: -50000 },
        { entryId: 'e-rachel', amountCents: 0 },
      ],
    });

    expect(result).toHaveLength(2);
    expectValidAllocation(result, -50000);
  });
});

// =====================================================================
// METHOD 2: PRO-RATA BY VALUE
// =====================================================================

describe('allocateProRataByValue', () => {
  it('distributes proportionally to standard amounts', () => {
    // Total WIP = $3,950. Write down $395 (10%).
    // Each entry takes 10% of its standard amount.
    const result = allocateProRataByValue({
      totalAmountCents: -39500,
      timeEntries: VANCE,
    });

    expect(result).toHaveLength(4);
    expect(result.find((r) => r.timeEntryId === 'e-sarah')?.adjustmentAmountCents).toBe(-10000);
    expect(result.find((r) => r.timeEntryId === 'e-mike')?.adjustmentAmountCents).toBe(-12000);
    expect(result.find((r) => r.timeEntryId === 'e-rachel')?.adjustmentAmountCents).toBe(-7500);
    expect(result.find((r) => r.timeEntryId === 'e-jenny')?.adjustmentAmountCents).toBe(-10000);
    expectValidAllocation(result, -39500);
  });

  it('applies identical percentages — mathematical property', () => {
    const result = allocateProRataByValue({
      totalAmountCents: -39500,
      timeEntries: VANCE,
    });

    // adjustment% = adjustment_amount / original_value should be ~ -0.10 for all
    for (const r of result) {
      const pct = r.adjustmentAmountCents / r.originalValueCents;
      expect(pct).toBeCloseTo(-0.1, 4);
    }
  });

  it('handles rounding by absorbing the remainder into the largest entry', () => {
    // $100 total adjustment, 3 equal entries → $33.33 each won't sum.
    // Algorithm: floor each, distribute remainder to entries by descending size.
    const entries: TimeEntryInput[] = [
      { id: 'a', appUserId: 'ua', appUserRole: 'PARTNER', hours: 1, standardAmountCents: 100 },
      { id: 'b', appUserId: 'ub', appUserRole: 'MANAGER', hours: 1, standardAmountCents: 100 },
      { id: 'c', appUserId: 'uc', appUserRole: 'STAFF',   hours: 1, standardAmountCents: 100 },
    ];
    const result = allocateProRataByValue({
      totalAmountCents: -100,
      timeEntries: entries,
    });

    expectSumEqualsTotal(result, -100);
    // Each allocation is roughly -$0.33 but exact distribution depends on impl
    const amounts = result.map((r) => r.adjustmentAmountCents).sort();
    expect(amounts.reduce((s, a) => s + a, 0)).toBe(-100);
  });

  it('symmetric write-up: positive total distributes positively', () => {
    const result = allocateProRataByValue({
      totalAmountCents: 39500,
      timeEntries: VANCE,
    });
    expectValidAllocation(result, 39500);
    for (const r of result) {
      expect(r.adjustmentAmountCents).toBeGreaterThan(0);
      expect(r.adjustedValueCents).toBeGreaterThan(r.originalValueCents);
    }
  });

  it('preserves per-timekeeper grain when one timekeeper has multiple entries', () => {
    const result = allocateProRataByValue({
      totalAmountCents: -38000,
      timeEntries: MULTI_ENTRY,
    });
    expect(result).toHaveLength(MULTI_ENTRY.length);
    expectValidAllocation(result, -38000);
    // Sarah's two entries each get half of her share
    const sarahEntries = result.filter((r) => r.appUserId === 'u-sarah');
    expect(sarahEntries).toHaveLength(2);
    expect(sarahEntries[0]!.adjustmentAmountCents).toBe(sarahEntries[1]!.adjustmentAmountCents);
  });
});

// =====================================================================
// METHOD 3: PRO-RATA BY HOURS
// =====================================================================

describe('allocateProRataByHours', () => {
  it('distributes proportionally to hours regardless of rate', () => {
    // VANCE total = 14h. Write down $140 → $10/h.
    const result = allocateProRataByHours({
      totalAmountCents: -14000,
      timeEntries: VANCE,
    });

    expect(result.find((r) => r.timeEntryId === 'e-sarah')?.adjustmentAmountCents).toBe(-2000);
    expect(result.find((r) => r.timeEntryId === 'e-mike')?.adjustmentAmountCents).toBe(-4000);
    expect(result.find((r) => r.timeEntryId === 'e-rachel')?.adjustmentAmountCents).toBe(-3000);
    expect(result.find((r) => r.timeEntryId === 'e-jenny')?.adjustmentAmountCents).toBe(-5000);
    expectValidAllocation(result, -14000);
  });

  it('produces different distribution than pro-rata-by-value when rates differ', () => {
    const byValue = allocateProRataByValue({ totalAmountCents: -14000, timeEntries: VANCE });
    const byHours = allocateProRataByHours({ totalAmountCents: -14000, timeEntries: VANCE });

    const sarahByValue = byValue.find((r) => r.timeEntryId === 'e-sarah')!.adjustmentAmountCents;
    const sarahByHours = byHours.find((r) => r.timeEntryId === 'e-sarah')!.adjustmentAmountCents;
    expect(sarahByValue).not.toBe(sarahByHours);
  });

  it('preserves grain across multiple entries per timekeeper', () => {
    const result = allocateProRataByHours({
      totalAmountCents: -10000,
      timeEntries: MULTI_ENTRY,
    });
    expectValidAllocation(result, -10000);
  });

  it('symmetric write-up', () => {
    const result = allocateProRataByHours({
      totalAmountCents: 14000,
      timeEntries: VANCE,
    });
    expectValidAllocation(result, 14000);
    for (const r of result) {
      expect(r.adjustmentAmountCents).toBeGreaterThan(0);
    }
  });
});

// =====================================================================
// METHOD 4: PARTNER ABSORBS
// =====================================================================

describe('allocatePartnerAbsorbs', () => {
  it('puts the entire adjustment on partner entries only', () => {
    // Write down $500. Sarah is the only partner.
    const result = allocatePartnerAbsorbs({
      totalAmountCents: -50000,
      timeEntries: VANCE,
    });

    // Non-partner entries get $0 allocations (still present for grain, but zero)
    const nonPartnerResults = result.filter((r) => r.appUserId !== 'u-sarah');
    for (const r of nonPartnerResults) {
      expect(r.adjustmentAmountCents).toBe(0);
    }

    // All $500 lands on Sarah
    const sarahResults = result.filter((r) => r.appUserId === 'u-sarah');
    const sarahSum = sarahResults.reduce((s, r) => s + r.adjustmentAmountCents, 0);
    expect(sarahSum).toBe(-50000);

    expectValidAllocation(result, -50000);
  });

  it('distributes across multiple partner entries proportionally to their value', () => {
    const entries: TimeEntryInput[] = [
      { id: 'p1', appUserId: 'u-p',  appUserRole: 'PARTNER', hours: 2, standardAmountCents: 100000 },
      { id: 'p2', appUserId: 'u-p2', appUserRole: 'PARTNER', hours: 4, standardAmountCents: 200000 },
      { id: 's1', appUserId: 'u-s',  appUserRole: 'STAFF',   hours: 8, standardAmountCents:  80000 },
    ];

    const result = allocatePartnerAbsorbs({
      totalAmountCents: -30000,
      timeEntries: entries,
    });

    // Staff entry gets zero
    expect(result.find((r) => r.timeEntryId === 's1')?.adjustmentAmountCents).toBe(0);

    // Partner entries split proportional to value: p1=$100k, p2=$200k → 1:2 ratio
    expect(result.find((r) => r.timeEntryId === 'p1')?.adjustmentAmountCents).toBe(-10000);
    expect(result.find((r) => r.timeEntryId === 'p2')?.adjustmentAmountCents).toBe(-20000);

    expectValidAllocation(result, -30000);
  });

  it('throws if no partner entries exist', () => {
    const noPartner: TimeEntryInput[] = [
      { id: 'm1', appUserId: 'u-m', appUserRole: 'MANAGER', hours: 4, standardAmountCents: 120000 },
      { id: 's1', appUserId: 'u-s', appUserRole: 'STAFF',   hours: 5, standardAmountCents: 100000 },
    ];
    expect(() =>
      allocatePartnerAbsorbs({
        totalAmountCents: -10000,
        timeEntries: noPartner,
      }),
    ).toThrow(/no partner/i);
  });

  it('symmetric write-up: partner gets all the upside', () => {
    const result = allocatePartnerAbsorbs({
      totalAmountCents: 50000,
      timeEntries: VANCE,
    });
    expectValidAllocation(result, 50000);
    const sarah = result.find((r) => r.appUserId === 'u-sarah');
    expect(sarah!.adjustmentAmountCents).toBe(50000);
  });
});

// =====================================================================
// METHOD 5: HIERARCHICAL CASCADE
//
// Junior staff held harmless first. Cascade absorbs upward.
// Default cascade order: STAFF (held harmless) → SENIOR → MANAGER → PARTNER (absorbs first).
// "Hold harmless" = $0 allocation. "Absorbs" = takes proportional hit.
//
// The Vance scenario from the mockup:
//   $1,200 adjustment with hierarchical cascade
//   Sarah Chen (partner) 0% realization on her time (absorbs all)
//   Mike Davis (manager) 97% (small residual)
//   Rachel Kim (senior) 100% (held harmless)
//   Jenny Park (staff) 100% (held harmless)
// =====================================================================

describe('allocateHierarchicalCascade', () => {
  it('holds junior staff harmless and cascades upward', () => {
    const result = allocateHierarchicalCascade({
      totalAmountCents: -120000,
      timeEntries: VANCE,
      cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'],
    });

    // Staff (Jenny) and Senior (Rachel) get $0 allocation (held harmless)
    expect(result.find((r) => r.appUserId === 'u-jenny')?.adjustmentAmountCents).toBe(0);
    expect(result.find((r) => r.appUserId === 'u-rachel')?.adjustmentAmountCents).toBe(0);

    // Partner (Sarah) absorbs first: max she can absorb is her full $1,000
    const sarahAdj = result.find((r) => r.appUserId === 'u-sarah')?.adjustmentAmountCents;
    expect(sarahAdj).toBe(-100000); // Sarah's full WIP absorbed

    // Manager (Mike) absorbs the remaining $200
    const mikeAdj = result.find((r) => r.appUserId === 'u-mike')?.adjustmentAmountCents;
    expect(mikeAdj).toBe(-20000);

    expectValidAllocation(result, -120000);
  });

  it('matches the Vance mockup scenario exactly (Sarah 0%, Mike 97%)', () => {
    const result = allocateHierarchicalCascade({
      totalAmountCents: -120000,
      timeEntries: VANCE,
      cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'],
    });

    // Compute realization per timekeeper
    const totalsByUser = new Map<string, { original: number; adjusted: number }>();
    for (const r of result) {
      const cur = totalsByUser.get(r.appUserId) ?? { original: 0, adjusted: 0 };
      cur.original += r.originalValueCents;
      cur.adjusted += r.adjustedValueCents;
      totalsByUser.set(r.appUserId, cur);
    }

    const realization = (userId: string) => {
      const t = totalsByUser.get(userId)!;
      return t.adjusted / t.original;
    };

    expect(realization('u-sarah')).toBeCloseTo(0.0, 2);     // 0% — fully absorbed
    expect(realization('u-mike')).toBeCloseTo(0.833, 2);     // 83.3% — partial hit (200/1200)
    expect(realization('u-rachel')).toBeCloseTo(1.0, 2);     // 100% — held harmless
    expect(realization('u-jenny')).toBeCloseTo(1.0, 2);      // 100% — held harmless
  });

  it('cascades fully upward when partner alone can absorb', () => {
    const result = allocateHierarchicalCascade({
      totalAmountCents: -50000,
      timeEntries: VANCE,
      cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'],
    });

    // Sarah absorbs all $500, no one else gets hit
    const nonPartner = result.filter((r) => r.appUserRole !== 'PARTNER');
    for (const r of nonPartner) {
      expect(r.adjustmentAmountCents).toBe(0);
    }
    expect(result.find((r) => r.appUserId === 'u-sarah')?.adjustmentAmountCents).toBe(-50000);
    expectValidAllocation(result, -50000);
  });

  it('throws when adjustment exceeds total WIP', () => {
    // VANCE total WIP = $3,950. Try to write down $5,000.
    expect(() =>
      allocateHierarchicalCascade({
        totalAmountCents: -500000,
        timeEntries: VANCE,
        cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'],
      }),
    ).toThrow(/exceeds.*wip/i);
  });

  it('respects custom cascade orders', () => {
    // Reverse order: STAFF absorbs first, PARTNER held harmless
    const result = allocateHierarchicalCascade({
      totalAmountCents: -50000,
      timeEntries: VANCE,
      cascadeOrder: ['PARTNER', 'MANAGER', 'SENIOR', 'STAFF'],
    });

    // Sarah (partner) and Mike (manager) and Rachel (senior) held harmless
    expect(result.find((r) => r.appUserId === 'u-sarah')?.adjustmentAmountCents).toBe(0);
    expect(result.find((r) => r.appUserId === 'u-mike')?.adjustmentAmountCents).toBe(0);
    expect(result.find((r) => r.appUserId === 'u-rachel')?.adjustmentAmountCents).toBe(0);
    expect(result.find((r) => r.appUserId === 'u-jenny')?.adjustmentAmountCents).toBe(-50000);

    expectValidAllocation(result, -50000);
  });

  it('symmetric write-up: top of cascade gets all the upside', () => {
    const result = allocateHierarchicalCascade({
      totalAmountCents: 50000,
      timeEntries: VANCE,
      cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'],
    });
    expectValidAllocation(result, 50000);
    // Partner gets the full upside
    const sarah = result.find((r) => r.appUserId === 'u-sarah');
    expect(sarah!.adjustmentAmountCents).toBe(50000);
  });
});

// =====================================================================
// METHOD 6: CUSTOM WEIGHTED (PERCENT MODE)
// =====================================================================

describe('allocateCustomWeighted — percent mode', () => {
  it('allocates per-user percentages, distributed across their entries by value', () => {
    const result = allocateCustomWeighted({
      totalAmountCents: -100000,
      timeEntries: VANCE,
      weightingMode: 'PERCENT',
      weights: [
        { appUserId: 'u-sarah', weight: 50 },
        { appUserId: 'u-mike', weight: 30 },
        { appUserId: 'u-rachel', weight: 20 },
        // Jenny intentionally omitted → 0%
      ],
    });

    // Sum per user
    const userTotals = new Map<string, number>();
    for (const r of result) {
      userTotals.set(r.appUserId, (userTotals.get(r.appUserId) ?? 0) + r.adjustmentAmountCents);
    }

    expect(userTotals.get('u-sarah')).toBe(-50000);
    expect(userTotals.get('u-mike')).toBe(-30000);
    expect(userTotals.get('u-rachel')).toBe(-20000);
    expect(userTotals.get('u-jenny') ?? 0).toBe(0);

    expectValidAllocation(result, -100000);
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(() =>
      allocateCustomWeighted({
        totalAmountCents: -100000,
        timeEntries: VANCE,
        weightingMode: 'PERCENT',
        weights: [
          { appUserId: 'u-sarah', weight: 60 },
          { appUserId: 'u-mike', weight: 30 },
          // Sums to 90, not 100
        ],
      }),
    ).toThrow(/sum.*100/i);
  });

  it('accepts percentages within 0.01 tolerance of 100', () => {
    // 33.33 + 33.33 + 33.34 = 100.00
    const result = allocateCustomWeighted({
      totalAmountCents: -100000,
      timeEntries: VANCE.slice(0, 3),
      weightingMode: 'PERCENT',
      weights: [
        { appUserId: 'u-sarah', weight: 33.33 },
        { appUserId: 'u-mike', weight: 33.33 },
        { appUserId: 'u-rachel', weight: 33.34 },
      ],
    });
    expectValidAllocation(result, -100000);
  });
});

// =====================================================================
// METHOD 6: CUSTOM WEIGHTED (DOLLAR MODE)
// =====================================================================

describe('allocateCustomWeighted — dollar mode', () => {
  it('allocates per-user dollar amounts, distributed across their entries by value', () => {
    const result = allocateCustomWeighted({
      totalAmountCents: -100000,
      timeEntries: VANCE,
      weightingMode: 'DOLLAR',
      weights: [
        { appUserId: 'u-sarah', weight: -40000 },
        { appUserId: 'u-mike', weight: -60000 },
      ],
    });

    const userTotals = new Map<string, number>();
    for (const r of result) {
      userTotals.set(r.appUserId, (userTotals.get(r.appUserId) ?? 0) + r.adjustmentAmountCents);
    }

    expect(userTotals.get('u-sarah')).toBe(-40000);
    expect(userTotals.get('u-mike')).toBe(-60000);
    expect(userTotals.get('u-rachel') ?? 0).toBe(0);
    expect(userTotals.get('u-jenny') ?? 0).toBe(0);

    expectValidAllocation(result, -100000);
  });

  it('rejects dollar amounts that do not sum to total', () => {
    expect(() =>
      allocateCustomWeighted({
        totalAmountCents: -100000,
        timeEntries: VANCE,
        weightingMode: 'DOLLAR',
        weights: [
          { appUserId: 'u-sarah', weight: -40000 },
          { appUserId: 'u-mike', weight: -50000 },
          // Sums to -90000, not -100000
        ],
      }),
    ).toThrow(/sum.*total/i);
  });

  it('allows zero allocation to a listed timekeeper', () => {
    const result = allocateCustomWeighted({
      totalAmountCents: -100000,
      timeEntries: VANCE,
      weightingMode: 'DOLLAR',
      weights: [
        { appUserId: 'u-sarah', weight: -100000 },
        { appUserId: 'u-mike', weight: 0 },
      ],
    });
    expectValidAllocation(result, -100000);
  });
});

// =====================================================================
// SINGLE-ENTRY EDGE CASES
// =====================================================================

describe('Single-entry allocation', () => {
  it('all methods correctly allocate a single entry', () => {
    const total = -10000;
    const methods = [
      { fn: () => allocateProRataByValue({ totalAmountCents: total, timeEntries: SINGLE_ENTRY }), name: 'pro-rata-by-value' },
      { fn: () => allocateProRataByHours({ totalAmountCents: total, timeEntries: SINGLE_ENTRY }), name: 'pro-rata-by-hours' },
      { fn: () => allocatePartnerAbsorbs({ totalAmountCents: total, timeEntries: SINGLE_ENTRY }), name: 'partner-absorbs' },
      { fn: () => allocateHierarchicalCascade({ totalAmountCents: total, timeEntries: SINGLE_ENTRY, cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'] }), name: 'hierarchical-cascade' },
    ];

    for (const { fn, name } of methods) {
      const result = fn();
      expectValidAllocation(result, total);
      expect(result, `${name} should return one allocation`).toHaveLength(1);
      expect(result[0]!.adjustmentAmountCents).toBe(total);
    }
  });
});

// =====================================================================
// CROSS-CUTTING: REVERSAL CORRECTNESS
//
// Reversing an adjustment must restore the original realization exactly.
// Algebraically: forward adjustment moves adjusted_value by adjustment_amount;
// reverse adjustment moves it back by -adjustment_amount.
// =====================================================================

describe('Reversal correctness', () => {
  it('pro-rata-by-value: applying then reversing returns to original', () => {
    const forward = allocateProRataByValue({
      totalAmountCents: -50000,
      timeEntries: VANCE,
    });

    // Synthesize reversal: each entry now has adjusted_value as new "original"
    const reversedEntries = forward.map((f) => ({
      ...VANCE.find((e) => e.id === f.timeEntryId)!,
      standardAmountCents: f.adjustedValueCents,
    }));

    const reverse = allocateProRataByValue({
      totalAmountCents: 50000,
      timeEntries: reversedEntries,
    });

    // For each entry, forward.adjusted + reverse.adjustment ≈ forward.original (±1¢)
    for (const f of forward) {
      const r = reverse.find((x) => x.timeEntryId === f.timeEntryId)!;
      const restored = f.adjustedValueCents + r.adjustmentAmountCents;
      expect(Math.abs(restored - f.originalValueCents)).toBeLessThanOrEqual(1);
    }
  });

  it('hierarchical cascade: applying then reversing returns to original', () => {
    const forward = allocateHierarchicalCascade({
      totalAmountCents: -120000,
      timeEntries: VANCE,
      cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'],
    });

    const reversedEntries = forward.map((f) => ({
      ...VANCE.find((e) => e.id === f.timeEntryId)!,
      standardAmountCents: f.adjustedValueCents,
    }));

    const reverse = allocateHierarchicalCascade({
      totalAmountCents: 120000,
      timeEntries: reversedEntries,
      cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'],
    });

    for (const f of forward) {
      const r = reverse.find((x) => x.timeEntryId === f.timeEntryId)!;
      const restored = f.adjustedValueCents + r.adjustmentAmountCents;
      expect(Math.abs(restored - f.originalValueCents)).toBeLessThanOrEqual(1);
    }
  });
});

// =====================================================================
// CROSS-CUTTING: GRAIN PRESERVATION
//
// In every allocation method, multi-entry timekeepers must have one
// allocation row per entry, and the sum across their entries must equal
// their total share.
// =====================================================================

describe('Grain preservation invariant', () => {
  it.each([
    ['pro-rata-by-value', () => allocateProRataByValue({ totalAmountCents: -10000, timeEntries: MULTI_ENTRY })],
    ['pro-rata-by-hours', () => allocateProRataByHours({ totalAmountCents: -10000, timeEntries: MULTI_ENTRY })],
    ['partner-absorbs', () => allocatePartnerAbsorbs({ totalAmountCents: -10000, timeEntries: MULTI_ENTRY })],
    ['hierarchical-cascade', () => allocateHierarchicalCascade({
      totalAmountCents: -10000,
      timeEntries: MULTI_ENTRY,
      cascadeOrder: ['STAFF', 'SENIOR', 'MANAGER', 'PARTNER'],
    })],
  ])('%s produces one allocation per (entry, user) pair', (_name, fn) => {
    const result = fn();
    expectGrainPreserved(result);

    // Sarah has 2 entries — exactly 2 allocations
    const sarahCount = result.filter((r) => r.appUserId === 'u-sarah').length;
    expect(sarahCount).toBe(2);

    // Mike has 3 entries — exactly 3 allocations
    const mikeCount = result.filter((r) => r.appUserId === 'u-mike').length;
    expect(mikeCount).toBe(3);
  });
});

// =====================================================================
// CROSS-CUTTING: ZERO-AMOUNT
//
// A $0 adjustment is a no-op but still produces allocation rows for
// auditability (one per entry, all with $0 amount).
// =====================================================================

describe('Zero-amount adjustment', () => {
  it('produces zero-value allocations for every entry', () => {
    const result = allocateProRataByValue({
      totalAmountCents: 0,
      timeEntries: VANCE,
    });
    expect(result).toHaveLength(VANCE.length);
    for (const r of result) {
      expect(r.adjustmentAmountCents).toBe(0);
      expect(r.adjustedValueCents).toBe(r.originalValueCents);
    }
  });
});
