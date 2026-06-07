// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0

import { describe, expect, it } from 'vitest';

import {
  classifyAchReturn,
  planAchRetry,
  MAX_ACH_RETRIES,
  ACH_RETRY_WINDOW_DAYS,
} from './ach-returns';

const DAY = 86_400_000;

describe('classifyAchReturn', () => {
  it('treats R01/R09 as retriable, mandate intact', () => {
    for (const code of ['R01', 'R09', 'r01']) {
      const c = classifyAchReturn(code);
      expect(c.retriable).toBe(true);
      expect(c.invalidatesMandate).toBe(false);
      expect(c.category).toBe('INSUFFICIENT_FUNDS');
    }
  });

  it('treats no-authorization codes as halt + invalidate mandate', () => {
    for (const code of ['R05', 'R07', 'R08', 'R10', 'R29']) {
      const c = classifyAchReturn(code);
      expect(c.retriable).toBe(false);
      expect(c.invalidatesMandate).toBe(true);
      expect(c.category).toBe('NO_AUTHORIZATION');
    }
  });

  it('treats account errors as halt + invalidate + block PM', () => {
    for (const code of ['R02', 'R03', 'R04', 'R16', 'R20']) {
      const c = classifyAchReturn(code);
      expect(c.retriable).toBe(false);
      expect(c.invalidatesMandate).toBe(true);
      expect(c.blocksPaymentMethod).toBe(true);
      expect(c.category).toBe('ACCOUNT_ERROR');
    }
  });

  it('unknown codes halt but keep the mandate', () => {
    const c = classifyAchReturn('R99');
    expect(c.retriable).toBe(false);
    expect(c.invalidatesMandate).toBe(false);
    expect(c.category).toBe('OTHER');
  });

  it('maps Stripe string failure codes to NACHA categories', () => {
    expect(classifyAchReturn('insufficient_funds').retriable).toBe(true);
    expect(classifyAchReturn('debit_not_authorized').invalidatesMandate).toBe(true);
    const closed = classifyAchReturn('account_closed');
    expect(closed.category).toBe('ACCOUNT_ERROR');
    expect(closed.blocksPaymentMethod).toBe(true);
  });
});

describe('planAchRetry', () => {
  const firstFailureAt = new Date('2026-04-01T00:00:00Z');

  it('schedules a retry for R01 within cap + window', () => {
    const d = planAchRetry({
      code: 'R01',
      retriesSoFar: 0,
      firstFailureAt,
      now: firstFailureAt,
    });
    expect(d.retry).toBe(true);
    expect(d.reason).toBe('scheduled');
    expect(d.nextAt).toBeInstanceOf(Date);
  });

  it('never retries no-authorization codes', () => {
    const d = planAchRetry({
      code: 'R10',
      retriesSoFar: 0,
      firstFailureAt,
      now: firstFailureAt,
    });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe('requires_new_authorization');
  });

  it('stops after the NACHA retry cap', () => {
    const d = planAchRetry({
      code: 'R01',
      retriesSoFar: MAX_ACH_RETRIES,
      firstFailureAt,
      now: firstFailureAt,
    });
    expect(d.retry).toBe(false);
    expect(d.reason).toBe('max_attempts');
  });

  it('stops once the 40-day window has elapsed', () => {
    const now = new Date(firstFailureAt.getTime() + (ACH_RETRY_WINDOW_DAYS - 1) * DAY);
    const d = planAchRetry({ code: 'R01', retriesSoFar: 1, firstFailureAt, now });
    // next attempt (+5d) would land past day 40 → no retry
    expect(d.retry).toBe(false);
    expect(d.reason).toBe('window_elapsed');
  });
});
