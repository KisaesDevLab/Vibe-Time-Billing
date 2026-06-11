// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect } from 'vitest';

import { applyEntryAction, bucketForAge, bucketize, daysBetween } from './wip';

describe('wip aging', () => {
  it('daysBetween counts whole days', () => {
    expect(daysBetween('2026-05-01', '2026-05-15')).toBe(14);
    expect(daysBetween('2026-05-15', '2026-05-15')).toBe(0);
  });

  it('bucketForAge boundaries', () => {
    expect(bucketForAge(0)).toBe('0-30');
    expect(bucketForAge(30)).toBe('0-30');
    expect(bucketForAge(31)).toBe('31-60');
    expect(bucketForAge(60)).toBe('31-60');
    expect(bucketForAge(61)).toBe('61-90');
    expect(bucketForAge(91)).toBe('90+');
  });

  it('bucketize groups amounts by age', () => {
    const r = bucketize(
      [
        { entryDate: '2026-04-15', amountCents: 10000 }, // 35 days
        { entryDate: '2026-05-19', amountCents: 5000 }, // 1 day
      ],
      '2026-05-20',
    );
    expect(r['0-30']).toBe(5000);
    expect(r['31-60']).toBe(10000);
  });
});

describe('applyEntryAction', () => {
  it('INCLUDE batches the amount', () => {
    expect(applyEntryAction({ action: 'INCLUDE', entryAmountCents: 10000 })).toEqual({
      batchedAmountCents: 10000,
      carryForwardAmountCents: 0,
      writtenOffAmountCents: 0,
    });
  });
  it('DEFER carries forward', () => {
    expect(applyEntryAction({ action: 'DEFER', entryAmountCents: 10000 })).toEqual({
      batchedAmountCents: 0,
      carryForwardAmountCents: 10000,
      writtenOffAmountCents: 0,
    });
  });
  it('WRITE_OFF removes', () => {
    expect(applyEntryAction({ action: 'WRITE_OFF', entryAmountCents: 10000 })).toEqual({
      batchedAmountCents: 0,
      carryForwardAmountCents: 0,
      writtenOffAmountCents: 10000,
    });
  });
});
