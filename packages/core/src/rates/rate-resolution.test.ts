// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { describe, it, expect } from 'vitest';

import { captureRateSnapshot, resolveRate, type RateCandidate } from './rate-resolution';

const baseInput = {
  serviceDate: '2026-03-15',
  appUserId: 'u-sarah',
  engagementId: 'e-1',
  clientId: 'c-1',
  serviceLineId: 'sl-tax',
  rateCodeId: 'rc-standard',
  firmDefaultBillRateCents: 25000,
};

describe('resolveRate', () => {
  it('falls through to firm default when nothing matches', () => {
    const r = resolveRate({ ...baseInput, candidates: [] });
    expect(r.level).toBe('firm');
    expect(r.billRateCents).toBe(25000);
    expect(r.trace.at(-1)).toEqual({ level: 'firm', status: 'win' });
  });

  it('picks engagement override over client and staff_rate', () => {
    const candidates: RateCandidate[] = [
      {
        level: 'engagement',
        engagementId: 'e-1',
        appUserId: 'u-sarah',
        billRateCents: 50000,
        effectiveStart: '2026-01-01',
      },
      {
        level: 'client',
        clientId: 'c-1',
        appUserId: 'u-sarah',
        billRateCents: 40000,
        effectiveStart: '2026-01-01',
      },
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 35000,
        effectiveStart: '2026-01-01',
      },
    ];
    const r = resolveRate({ ...baseInput, candidates });
    expect(r.level).toBe('engagement');
    expect(r.billRateCents).toBe(50000);
  });

  it('respects effective_start (rate not yet effective falls through)', () => {
    const candidates: RateCandidate[] = [
      {
        level: 'engagement',
        engagementId: 'e-1',
        appUserId: 'u-sarah',
        billRateCents: 50000,
        effectiveStart: '2026-07-01',
      },
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 35000,
        effectiveStart: '2026-01-01',
      },
    ];
    const r = resolveRate({ ...baseInput, candidates });
    expect(r.level).toBe('staff_rate');
    expect(r.billRateCents).toBe(35000);
  });

  it('respects effective_end (rate ended falls through)', () => {
    const candidates: RateCandidate[] = [
      {
        level: 'engagement',
        engagementId: 'e-1',
        appUserId: 'u-sarah',
        billRateCents: 50000,
        effectiveStart: '2025-01-01',
        effectiveEnd: '2026-01-01',
      },
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 35000,
        effectiveStart: '2026-01-01',
      },
    ];
    const r = resolveRate({ ...baseInput, candidates });
    expect(r.level).toBe('staff_rate');
  });

  it('picks most-recently-started when two effective rates overlap at the same level', () => {
    const candidates: RateCandidate[] = [
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 30000,
        effectiveStart: '2025-01-01',
      },
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 35000,
        effectiveStart: '2026-01-01',
      },
    ];
    const r = resolveRate({ ...baseInput, candidates });
    expect(r.billRateCents).toBe(35000);
  });

  it('prefers engagement rate code over StandardRate when both exist', () => {
    const candidates: RateCandidate[] = [
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 35000,
        effectiveStart: '2026-01-01',
      },
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-payroll',
        isStandardCode: false,
        billRateCents: 18000,
        effectiveStart: '2026-01-01',
      },
    ];
    const r = resolveRate({ ...baseInput, rateCodeId: 'rc-payroll', candidates });
    expect(r.level).toBe('staff_rate');
    expect(r.rateCodeId).toBe('rc-payroll');
    expect(r.billRateCents).toBe(18000);
  });

  it('falls back to StandardRate when the engagement rate code has no entry', () => {
    const candidates: RateCandidate[] = [
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 35000,
        effectiveStart: '2026-01-01',
      },
    ];
    const r = resolveRate({ ...baseInput, rateCodeId: 'rc-payroll', candidates });
    expect(r.level).toBe('staff_rate');
    expect(r.rateCodeId).toBe('rc-standard');
    expect(r.billRateCents).toBe(35000);
    expect(r.trace.at(-1)).toEqual({ level: 'staff_rate', status: 'fallback' });
  });

  it('captureRateSnapshot rounds to integer cents', () => {
    const r = resolveRate({ ...baseInput, candidates: [] });
    expect(captureRateSnapshot({ rate: r, hours: 2.5 })).toEqual({
      rateCents: 25000,
      amountCents: 62500,
      // 0063 — cost snapshot follows resolver's costRateCents. Pure
      // firm-fallback in this test has no cost rate plumbed in.
      costRateCents: null,
    });
    expect(captureRateSnapshot({ rate: r, hours: 1.234 })).toEqual({
      rateCents: 25000,
      amountCents: 30850,
      costRateCents: null,
    });
  });

  it('captureRateSnapshot carries cost rate through (NOT multiplier-adjusted)', () => {
    // 0063 — cost rate is firm-internal and should NOT be discounted by
    // the engagement multiplier. A 15% client discount must not look
    // like the staff is suddenly cheaper to employ.
    const r = resolveRate({
      ...baseInput,
      candidates: [
        {
          level: 'staff_rate',
          appUserId: baseInput.appUserId,
          rateCodeId: 'rc-standard',
          isStandardCode: true,
          billRateCents: 40000, // $400/hr
          costRateCents: 12000, // $120/hr cost
          effectiveStart: '2026-01-01',
        },
      ],
    });
    const snap = captureRateSnapshot({ rate: r, hours: 1, multiplierBps: 8500 });
    // Bill rate gets the multiplier (15% discount → $340)
    expect(snap.rateCents).toBe(34000);
    expect(snap.amountCents).toBe(34000);
    // Cost rate stays at the raw value — no multiplier
    expect(snap.costRateCents).toBe(12000);
  });

  it('historical rates do not shift when a newer rate is added', () => {
    // Entry on 2026-03-15 captures the rate then-effective. A new
    // rate starting 2026-07-01 must not retro-change the historical
    // resolution (CLAUDE.md non-negotiable #3).
    const candidatesOld: RateCandidate[] = [
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 35000,
        effectiveStart: '2026-01-01',
      },
    ];
    const oldResolution = resolveRate({ ...baseInput, candidates: candidatesOld });

    const candidatesNew: RateCandidate[] = [
      ...candidatesOld,
      {
        level: 'staff_rate',
        appUserId: 'u-sarah',
        rateCodeId: 'rc-standard',
        isStandardCode: true,
        billRateCents: 42000,
        effectiveStart: '2026-07-01',
      },
    ];
    const reResolveOldDate = resolveRate({ ...baseInput, candidates: candidatesNew });
    expect(reResolveOldDate.billRateCents).toBe(oldResolution.billRateCents);
  });
});
