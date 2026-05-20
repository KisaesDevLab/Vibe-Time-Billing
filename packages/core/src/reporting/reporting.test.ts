// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, it, expect } from 'vitest';

import { effectiveRate, rollup, rollupBy, utilization } from './realization';

describe('realization rollup', () => {
  const rows = [
    {
      appUserId: 'u1',
      engagementId: 'e1',
      clientId: 'c1',
      originalValueCents: 100000,
      adjustedValueCents: 0,
    },
    {
      appUserId: 'u2',
      engagementId: 'e1',
      clientId: 'c1',
      originalValueCents: 120000,
      adjustedValueCents: 100000,
    },
    {
      appUserId: 'u3',
      engagementId: 'e1',
      clientId: 'c1',
      originalValueCents: 75000,
      adjustedValueCents: 75000,
    },
    {
      appUserId: 'u4',
      engagementId: 'e1',
      clientId: 'c1',
      originalValueCents: 100000,
      adjustedValueCents: 100000,
    },
  ];

  it('rolls firm realization (engagement total / WIP)', () => {
    const r = rollup(rows);
    expect(r.originalValueCents).toBe(395000);
    expect(r.adjustedValueCents).toBe(275000);
    expect(r.realizationPct).toBeCloseTo(0.696, 3);
  });

  it('rolls per-timekeeper realization (cascade scenario)', () => {
    const by = rollupBy(rows, (r) => r.appUserId);
    expect(by.get('u1')!.realizationPct).toBe(0); // Sarah absorbed 100%
    expect(by.get('u2')!.realizationPct).toBeCloseTo(0.833, 3); // Mike
    expect(by.get('u3')!.realizationPct).toBe(1);
    expect(by.get('u4')!.realizationPct).toBe(1);
  });
});

describe('effectiveRate', () => {
  it('billed / hours, integer cents', () => {
    expect(effectiveRate({ billedCents: 240000, hours: 8 })).toBe(30000);
  });
  it('zero hours → zero', () => {
    expect(effectiveRate({ billedCents: 100, hours: 0 })).toBe(0);
  });
});

describe('utilization', () => {
  it('billable / available', () => {
    expect(utilization({ billableHours: 30, availableHours: 40 })).toBe(0.75);
  });
  it('caps at 100%', () => {
    expect(utilization({ billableHours: 80, availableHours: 40 })).toBe(1);
  });
});
