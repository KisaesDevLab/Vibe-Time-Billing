// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import {
  computeNextRunAt,
  frequencyToIntervalDays,
  isBackupDue,
  parseTimeOfDay,
  prunableBackups,
  retentionRecommendation,
  validateRetentionDays,
  RECOMMENDED_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
} from './schedule';

const DAY = 24 * 60 * 60 * 1000;

describe('frequencyToIntervalDays', () => {
  it('maps each frequency to its interval', () => {
    expect(frequencyToIntervalDays('daily')).toBe(1);
    expect(frequencyToIntervalDays('every_2_days')).toBe(2);
    expect(frequencyToIntervalDays('weekly')).toBe(7);
  });
});

describe('parseTimeOfDay', () => {
  it('parses valid 24h times', () => {
    expect(parseTimeOfDay('02:00')).toEqual({ hours: 2, minutes: 0 });
    expect(parseTimeOfDay('23:59')).toEqual({ hours: 23, minutes: 59 });
  });

  it('rejects malformed times', () => {
    expect(() => parseTimeOfDay('24:00')).toThrow('invalid');
    expect(() => parseTimeOfDay('2:00')).toThrow('invalid');
    expect(() => parseTimeOfDay('02:60')).toThrow('invalid');
    expect(() => parseTimeOfDay('nope')).toThrow('invalid');
  });
});

describe('computeNextRunAt', () => {
  it('never run + time-of-day still ahead → fires later today', () => {
    const now = new Date('2026-06-23T01:00:00Z');
    const next = computeNextRunAt({ frequency: 'daily', timeOfDayUtc: '02:00' }, null, now);
    expect(next.toISOString()).toBe('2026-06-23T02:00:00.000Z');
  });

  it("never run + time-of-day already passed → today's slot (overdue → due now)", () => {
    const now = new Date('2026-06-23T05:00:00Z');
    const next = computeNextRunAt({ frequency: 'daily', timeOfDayUtc: '02:00' }, null, now);
    expect(next.toISOString()).toBe('2026-06-23T02:00:00.000Z');
  });

  it('daily: one day after last success, snapped to time-of-day', () => {
    const last = new Date('2026-06-23T02:00:05Z');
    const next = computeNextRunAt({ frequency: 'daily', timeOfDayUtc: '02:00' }, last, new Date());
    expect(next.toISOString()).toBe('2026-06-24T02:00:00.000Z');
  });

  it('weekly: seven days after last success', () => {
    const last = new Date('2026-06-23T02:00:00Z');
    const next = computeNextRunAt({ frequency: 'weekly', timeOfDayUtc: '02:00' }, last, new Date());
    expect(next.toISOString()).toBe('2026-06-30T02:00:00.000Z');
  });

  it('calendar-based: ran late in the day → next calendar day at time-of-day', () => {
    // Ran at 23:00; daily → the next slot is the following calendar day at
    // 02:00 (≈3h later). Calendar cadence, not a strict 24h gap.
    const last = new Date('2026-06-23T23:00:00Z');
    const next = computeNextRunAt({ frequency: 'daily', timeOfDayUtc: '02:00' }, last, new Date());
    expect(next.toISOString()).toBe('2026-06-24T02:00:00.000Z');
  });
});

describe('isBackupDue', () => {
  const sched = { enabled: true, frequency: 'daily' as const, timeOfDayUtc: '02:00' };

  it('disabled is never due', () => {
    expect(isBackupDue({ ...sched, enabled: false }, null, new Date('2026-06-23T10:00:00Z'))).toBe(
      false,
    );
  });

  it('due once now passes the next-run instant', () => {
    const last = new Date('2026-06-22T02:00:00Z');
    expect(isBackupDue(sched, last, new Date('2026-06-23T01:59:00Z'))).toBe(false);
    expect(isBackupDue(sched, last, new Date('2026-06-23T02:00:00Z'))).toBe(true);
  });

  it('first-ever run is due as soon as the time-of-day arrives', () => {
    expect(isBackupDue(sched, null, new Date('2026-06-23T01:59:00Z'))).toBe(false);
    expect(isBackupDue(sched, null, new Date('2026-06-23T02:30:00Z'))).toBe(true);
  });
});

describe('prunableBackups', () => {
  const now = new Date('2026-06-23T00:00:00Z');
  it('returns only artifacts older than the retention window', () => {
    const arts = [
      { name: 'old.sql.gz', mtimeMs: now.getTime() - 31 * DAY },
      { name: 'edge.sql.gz', mtimeMs: now.getTime() - 29 * DAY },
      { name: 'fresh.sql.gz', mtimeMs: now.getTime() - 1 * DAY },
    ];
    expect(prunableBackups(arts, 30, now)).toEqual(['old.sql.gz']);
  });

  it('prunes nothing when all artifacts are within the window', () => {
    const arts = [{ name: 'a', mtimeMs: now.getTime() - 5 * DAY }];
    expect(prunableBackups(arts, 30, now)).toEqual([]);
  });
});

describe('validateRetentionDays', () => {
  it('accepts an in-range integer', () => {
    expect(validateRetentionDays(45)).toEqual({ ok: true, retentionDays: 45 });
  });

  it('clamps below minimum and above maximum', () => {
    expect(validateRetentionDays(0)).toMatchObject({
      ok: false,
      retentionDays: MIN_RETENTION_DAYS,
    });
    expect(validateRetentionDays(99999)).toMatchObject({
      ok: false,
      retentionDays: MAX_RETENTION_DAYS,
    });
  });

  it('rejects non-integers, falling back to the recommended default', () => {
    expect(validateRetentionDays(1.5)).toMatchObject({
      ok: false,
      retentionDays: RECOMMENDED_RETENTION_DAYS,
      reason: 'not_an_integer',
    });
  });
});

describe('retentionRecommendation', () => {
  it('mentions the recommended retention window', () => {
    expect(retentionRecommendation()).toContain(`${RECOMMENDED_RETENTION_DAYS} days`);
  });
});
