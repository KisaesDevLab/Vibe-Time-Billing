// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P23 — WIP rollup math tests.

import { describe, expect, it } from 'vitest';
import { rollUpEngagementWip, wipRollupToCsv, type TimeEntryForWip } from './wip-rollup';

function entry(p: Partial<TimeEntryForWip> & { appUserId: string }): TimeEntryForWip {
  return {
    appUserId: p.appUserId,
    workCodeId: p.workCodeId ?? null,
    hours: p.hours ?? 1,
    standardRateSnapshotCents: p.standardRateSnapshotCents ?? 20_000,
    billableFlag: p.billableFlag ?? true,
    inScopeFlag: p.inScopeFlag ?? true,
    outOfScopeOverride: p.outOfScopeOverride ?? false,
  };
}

describe('P23 — rollUpEngagementWip', () => {
  it('empty entries → zero everywhere', () => {
    const r = rollUpEngagementWip({
      feeStructure: 'FIXED_FEE',
      feeAmountCents: 100_000,
      entries: [],
    });
    expect(r.totalHours).toBe(0);
    expect(r.wipCents).toBe(0);
    expect(r.realizationBps).toBeNull();
    expect(r.byUser).toEqual([]);
    expect(r.byWorkCode).toEqual([]);
  });

  it('aggregates hours × rate per user', () => {
    const r = rollUpEngagementWip({
      feeStructure: 'FIXED_FEE',
      feeAmountCents: null,
      entries: [
        entry({ appUserId: 'u1', hours: 2, standardRateSnapshotCents: 25_000 }),
        entry({ appUserId: 'u1', hours: 1, standardRateSnapshotCents: 25_000 }),
        entry({ appUserId: 'u2', hours: 4, standardRateSnapshotCents: 30_000 }),
      ],
    });
    expect(r.totalHours).toBe(7);
    expect(r.wipCents).toBe(3 * 25_000 + 4 * 30_000);
    const u1 = r.byUser.find((u) => u.appUserId === 'u1')!;
    expect(u1.hours).toBe(3);
    expect(u1.amountCents).toBe(75_000);
    // Sorted descending by amount: u2 = 120k > u1 = 75k.
    expect(r.byUser[0]!.appUserId).toBe('u2');
  });

  it('aggregates per work-code with null grouped under sentinel', () => {
    const r = rollUpEngagementWip({
      feeStructure: 'HOURLY',
      feeAmountCents: null,
      entries: [
        entry({ appUserId: 'u1', workCodeId: 'wc1', hours: 1 }),
        entry({ appUserId: 'u1', workCodeId: 'wc1', hours: 2 }),
        entry({ appUserId: 'u1', workCodeId: null, hours: 1 }),
      ],
    });
    expect(r.byWorkCode.length).toBe(2);
    const wc1 = r.byWorkCode.find((w) => w.workCodeId === 'wc1')!;
    expect(wc1.hours).toBe(3);
    const none = r.byWorkCode.find((w) => w.workCodeId === null)!;
    expect(none.hours).toBe(1);
  });

  it('non-billable hours flow into wip but not billableWip', () => {
    const r = rollUpEngagementWip({
      feeStructure: 'FIXED_FEE',
      feeAmountCents: null,
      entries: [
        entry({ appUserId: 'u1', hours: 1, billableFlag: true }),
        entry({ appUserId: 'u1', hours: 1, billableFlag: false }),
      ],
    });
    expect(r.wipCents).toBe(40_000);
    expect(r.billableWipCents).toBe(20_000);
  });

  it('out-of-scope override removes the entry from inScopeWip', () => {
    const r = rollUpEngagementWip({
      feeStructure: 'FIXED_FEE',
      feeAmountCents: null,
      entries: [
        entry({ appUserId: 'u1', hours: 1, inScopeFlag: true }),
        entry({ appUserId: 'u1', hours: 1, inScopeFlag: true, outOfScopeOverride: true }),
        entry({ appUserId: 'u1', hours: 1, inScopeFlag: false }),
      ],
    });
    expect(r.wipCents).toBe(60_000);
    expect(r.inScopeWipCents).toBe(20_000);
  });

  describe('realization', () => {
    it('FIXED_FEE: realization = fee / wip', () => {
      const r = rollUpEngagementWip({
        feeStructure: 'FIXED_FEE',
        feeAmountCents: 100_000,
        entries: [entry({ appUserId: 'u1', hours: 5, standardRateSnapshotCents: 20_000 })],
      });
      // wip = 100k; realization 100% → 10_000 bps
      expect(r.realizationBps).toBe(10_000);
      expect(r.realizationBasis).toBe('FIXED_FEE');
    });

    it('FIXED_FEE: realization < 100% when wip exceeds fee', () => {
      const r = rollUpEngagementWip({
        feeStructure: 'FIXED_FEE',
        feeAmountCents: 100_000,
        entries: [entry({ appUserId: 'u1', hours: 6, standardRateSnapshotCents: 20_000 })],
      });
      // wip = 120k; realization = 100k/120k ≈ 83.33% → 8_333 bps
      expect(r.realizationBps).toBe(8_333);
    });

    it('FIXED_FEE_WITH_MILESTONES uses the same formula', () => {
      const r = rollUpEngagementWip({
        feeStructure: 'FIXED_FEE_WITH_MILESTONES',
        feeAmountCents: 200_000,
        entries: [entry({ appUserId: 'u1', hours: 5, standardRateSnapshotCents: 20_000 })],
      });
      expect(r.realizationBps).toBe(20_000);
      expect(r.realizationBasis).toBe('FIXED_FEE');
    });

    it('HOURLY without billedCents → 100% by definition', () => {
      const r = rollUpEngagementWip({
        feeStructure: 'HOURLY',
        feeAmountCents: null,
        entries: [entry({ appUserId: 'u1', hours: 3 })],
      });
      expect(r.realizationBps).toBe(10_000);
      expect(r.realizationBasis).toBe('T_AND_M');
    });

    it('HOURLY with billedCents below wip → realization < 100%', () => {
      const r = rollUpEngagementWip({
        feeStructure: 'HOURLY',
        feeAmountCents: null,
        billedCents: 50_000,
        entries: [entry({ appUserId: 'u1', hours: 5, standardRateSnapshotCents: 20_000 })],
      });
      // wip = 100k, billed = 50k → 50%
      expect(r.realizationBps).toBe(5_000);
    });

    it('RECURRING_SUBSCRIPTION uses billedCents', () => {
      const r = rollUpEngagementWip({
        feeStructure: 'RECURRING_SUBSCRIPTION',
        feeAmountCents: null,
        billedCents: 120_000,
        entries: [entry({ appUserId: 'u1', hours: 4, standardRateSnapshotCents: 30_000 })],
      });
      // wip = 120k, billed = 120k → 100%
      expect(r.realizationBps).toBe(10_000);
      expect(r.realizationBasis).toBe('RECURRING_BILLED');
    });

    it('FIXED_FEE without feeAmountCents → realization null', () => {
      const r = rollUpEngagementWip({
        feeStructure: 'FIXED_FEE',
        feeAmountCents: null,
        entries: [entry({ appUserId: 'u1' })],
      });
      expect(r.realizationBps).toBeNull();
      expect(r.realizationBasis).toBe('NONE');
    });
  });

  it('accepts hours as numeric string (PG numeric mode)', () => {
    const r = rollUpEngagementWip({
      feeStructure: 'HOURLY',
      feeAmountCents: null,
      entries: [
        {
          appUserId: 'u1',
          workCodeId: null,
          hours: '2.50',
          standardRateSnapshotCents: 20_000,
          billableFlag: true,
          inScopeFlag: true,
          outOfScopeOverride: false,
        },
      ],
    });
    expect(r.totalHours).toBe(2.5);
    expect(r.wipCents).toBe(50_000);
  });
});

describe('P23 — wipRollupToCsv', () => {
  it('emits header, summary, per-user, per-work-code blocks', () => {
    const r = rollUpEngagementWip({
      feeStructure: 'FIXED_FEE',
      feeAmountCents: 100_000,
      entries: [
        entry({ appUserId: 'u1', workCodeId: 'wc1', hours: 2, standardRateSnapshotCents: 20_000 }),
        entry({ appUserId: 'u2', workCodeId: 'wc2', hours: 1, standardRateSnapshotCents: 30_000 }),
      ],
    });
    const csv = wipRollupToCsv(r, {
      engagementName: 'Q1 Bookkeeping',
      feeStructure: 'FIXED_FEE',
      feeAmountCents: 100_000,
      userNames: { u1: 'Alex', u2: 'Pat' },
      workCodeNames: { wc1: 'Booking', wc2: 'Review' },
    });
    expect(csv).toContain('# Engagement,Q1 Bookkeeping');
    expect(csv).toContain('Summary');
    expect(csv).toContain('By user');
    expect(csv).toContain('Alex');
    expect(csv).toContain('Booking');
  });

  it('escapes commas + quotes in names', () => {
    const r = rollUpEngagementWip({
      feeStructure: 'HOURLY',
      feeAmountCents: null,
      entries: [entry({ appUserId: 'u1' })],
    });
    const csv = wipRollupToCsv(r, {
      engagementName: 'Smith, "Co"',
      feeStructure: 'HOURLY',
      feeAmountCents: null,
    });
    expect(csv).toContain('"Smith, ""Co"""');
  });
});
