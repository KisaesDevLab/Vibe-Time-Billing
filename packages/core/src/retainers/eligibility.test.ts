// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { isEligibleEntry } from './eligibility';

const eligibleCodes = ['tax-prep', 'review'];
const activeRetainer = { status: 'active' as const, expiryDate: '2029-04-15' };

describe('isEligibleEntry (D22)', () => {
  it('happy path: active, in-window, eligible code', () => {
    const r = isEligibleEntry({
      retainer: activeRetainer,
      entryDate: '2026-05-24',
      workCodeId: 'tax-prep',
      eligibleWorkCodeIds: eligibleCodes,
    });
    expect(r.ok).toBe(true);
  });

  it('entry on exact expiry_date is eligible (D22)', () => {
    const r = isEligibleEntry({
      retainer: activeRetainer,
      entryDate: '2029-04-15',
      workCodeId: 'tax-prep',
      eligibleWorkCodeIds: eligibleCodes,
    });
    expect(r.ok).toBe(true);
  });

  it('entry the day after expiry routes to WIP (reason=expired)', () => {
    const r = isEligibleEntry({
      retainer: activeRetainer,
      entryDate: '2029-04-16',
      workCodeId: 'tax-prep',
      eligibleWorkCodeIds: eligibleCodes,
    });
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('inactive status routes to WIP (reason=inactive)', () => {
    const r = isEligibleEntry({
      retainer: { status: 'exhausted', expiryDate: '2029-04-15' },
      entryDate: '2026-05-24',
      workCodeId: 'tax-prep',
      eligibleWorkCodeIds: eligibleCodes,
    });
    expect(r).toEqual({ ok: false, reason: 'inactive' });
  });

  it('expired status routes to WIP (reason=inactive — status check wins)', () => {
    // expiry sweep may not have run yet for an old retainer; entry today
    // is still tested first against status. Status takes precedence.
    const r = isEligibleEntry({
      retainer: { status: 'expired', expiryDate: '2026-04-15' },
      entryDate: '2026-05-24',
      workCodeId: 'tax-prep',
      eligibleWorkCodeIds: eligibleCodes,
    });
    expect(r).toEqual({ ok: false, reason: 'inactive' });
  });

  it('ineligible work code routes to WIP', () => {
    const r = isEligibleEntry({
      retainer: activeRetainer,
      entryDate: '2026-05-24',
      workCodeId: 'bookkeeping',
      eligibleWorkCodeIds: eligibleCodes,
    });
    expect(r).toEqual({ ok: false, reason: 'wrong_code' });
  });

  it('null work_code routes to WIP', () => {
    const r = isEligibleEntry({
      retainer: activeRetainer,
      entryDate: '2026-05-24',
      workCodeId: null,
      eligibleWorkCodeIds: eligibleCodes,
    });
    expect(r).toEqual({ ok: false, reason: 'wrong_code' });
  });
});
