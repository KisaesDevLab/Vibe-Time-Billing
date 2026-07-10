// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';

import { mapDate, mapDateTime, mapDeadlineAnchored, mapIsoWeek } from './mapping';

const wd = (iso: string): number => DateTime.fromISO(iso, { zone: 'utc' }).weekday;
const wn = (iso: string): number => DateTime.fromISO(iso, { zone: 'utc' }).weekNumber;
const wy = (iso: string): number => DateTime.fromISO(iso, { zone: 'utc' }).weekYear;

// Signed whole-week offset of a date from a month/day deadline in `year`.
function weekOffsetFrom(iso: string, month: number, day: number, year: number): number {
  const d = DateTime.fromISO(iso, { zone: 'utc' });
  const a = DateTime.fromObject({ year, month, day }, { zone: 'utc' });
  return Math.round(d.startOf('week').diff(a.startOf('week'), 'weeks').weeks);
}

describe('deadline-anchored mapping', () => {
  it('preserves the signed week-offset from 4/15 and the ISO weekday (1040)', () => {
    const src = '2025-04-01'; // a Tuesday, ~2 weeks before 4/15/2025
    const tgt = mapDeadlineAnchored(src, '1040', 2026);
    expect(wd(tgt)).toBe(wd(src)); // same weekday
    expect(weekOffsetFrom(tgt, 4, 15, 2026)).toBe(weekOffsetFrom(src, 4, 15, 2025));
    expect(tgt.startsWith('2026-')).toBe(true);
  });

  it('anchors entity returns to 3/15 (1120S, 1065)', () => {
    for (const rt of ['1120S', '1065']) {
      const src = '2025-03-04'; // a Tuesday
      const tgt = mapDeadlineAnchored(src, rt, 2026);
      expect(wd(tgt)).toBe(wd(src));
      expect(weekOffsetFrom(tgt, 3, 15, 2026)).toBe(weekOffsetFrom(src, 3, 15, 2025));
    }
  });

  it('keeps a date that IS the deadline week on the deadline week of the target', () => {
    const src = '2025-04-15'; // on the 1040 deadline
    const tgt = mapDeadlineAnchored(src, '1040', 2026);
    expect(weekOffsetFrom(tgt, 4, 15, 2026)).toBe(0); // same week as the target deadline
    expect(wd(tgt)).toBe(wd(src));
  });

  it('falls back to ISO-week mapping when returnType has no deadline', () => {
    const src = '2025-03-04';
    expect(mapDeadlineAnchored(src, null, 2026)).toBe(mapIsoWeek(src, 2026));
    expect(mapDeadlineAnchored(src, 'UNKNOWN', 2026)).toBe(mapIsoWeek(src, 2026));
  });

  it('uses the extension deadline when the source is in extension season', () => {
    const src = '2025-09-02'; // near 9/15 (1120S extension)
    const tgt = mapDeadlineAnchored(src, '1120S', 2026);
    expect(weekOffsetFrom(tgt, 9, 15, 2026)).toBe(weekOffsetFrom(src, 9, 15, 2025));
  });
});

describe('ISO-week-anchored mapping', () => {
  it('keeps the same ISO week number + weekday in the target week-year', () => {
    const src = '2025-03-04';
    const tgt = mapIsoWeek(src, 2026);
    expect(wn(tgt)).toBe(wn(src));
    expect(wd(tgt)).toBe(wd(src));
    expect(wy(tgt)).toBe(2026);
  });

  it('falls back from week 53 to week 52 when the target year has only 52 weeks', () => {
    const src = '2020-12-28'; // ISO week 53 of 2020 (Monday)
    expect(wn(src)).toBe(53);
    const tgt = mapIsoWeek(src, 2021); // 2021 has 52 ISO weeks
    expect(wn(tgt)).toBe(52);
    expect(wd(tgt)).toBe(wd(src));
  });
});

describe('mapDateTime', () => {
  it('preserves wall-clock time-of-day in the firm zone and the weekday', () => {
    const src = '2025-04-01T15:00:00.000Z'; // 10:00 America/Chicago (CDT)
    const out = mapDateTime({
      sourceUtcISO: src,
      returnType: '1040',
      targetYear: 2026,
      mode: 'DEADLINE',
      zone: 'America/Chicago',
    });
    const outCh = DateTime.fromISO(out, { zone: 'utc' }).setZone('America/Chicago');
    const srcCh = DateTime.fromISO(src, { zone: 'utc' }).setZone('America/Chicago');
    expect(outCh.hour).toBe(srcCh.hour); // 10
    expect(outCh.minute).toBe(srcCh.minute);
    expect(outCh.weekday).toBe(srcCh.weekday);
    expect(outCh.year).toBe(2026);
  });
});

describe('mapDate dispatcher', () => {
  it('routes to the selected mode', () => {
    const base = { sourceDate: '2025-04-01', returnType: '1040', targetYear: 2026 } as const;
    expect(mapDate({ ...base, mode: 'DEADLINE' })).toBe(
      mapDeadlineAnchored('2025-04-01', '1040', 2026),
    );
    expect(mapDate({ ...base, mode: 'ISO_WEEK' })).toBe(mapIsoWeek('2025-04-01', 2026));
  });
});
