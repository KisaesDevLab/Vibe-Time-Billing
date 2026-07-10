// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { nextTaskDueDate } from './recurrence';

describe('nextTaskDueDate', () => {
  it('advances weekly and bi-weekly by 7 / 14 days', () => {
    expect(nextTaskDueDate('2026-06-14', 'WEEKLY')).toBe('2026-06-21');
    expect(nextTaskDueDate('2026-06-14', 'BIWEEKLY')).toBe('2026-06-28');
  });

  it('advances monthly / quarterly / semiannual / annual', () => {
    expect(nextTaskDueDate('2026-06-14', 'MONTHLY')).toBe('2026-07-14');
    expect(nextTaskDueDate('2026-06-14', 'QUARTERLY')).toBe('2026-09-14');
    expect(nextTaskDueDate('2026-06-14', 'SEMIANNUAL')).toBe('2026-12-14');
    expect(nextTaskDueDate('2026-06-14', 'ANNUAL')).toBe('2027-06-14');
  });

  it('semimonthly anchors to the 1st & 15th', () => {
    // before the 16th → the 15th of the same month
    expect(nextTaskDueDate('2026-06-01', 'SEMIMONTHLY')).toBe('2026-06-15');
    expect(nextTaskDueDate('2026-06-10', 'SEMIMONTHLY')).toBe('2026-06-15');
    // on/after the 16th → the 1st of the next month
    expect(nextTaskDueDate('2026-06-15', 'SEMIMONTHLY')).toBe('2026-07-01');
    expect(nextTaskDueDate('2026-06-20', 'SEMIMONTHLY')).toBe('2026-07-01');
    // December second-half rolls into the new year
    expect(nextTaskDueDate('2026-12-20', 'SEMIMONTHLY')).toBe('2027-01-01');
  });

  it('handles month/year overflow like the billing helper', () => {
    // Jan 31 + 1 month overflows into early March (JS Date semantics)
    expect(nextTaskDueDate('2026-01-31', 'MONTHLY')).toBe('2026-03-03');
    expect(nextTaskDueDate('2026-12-31', 'MONTHLY')).toBe('2027-01-31');
    expect(nextTaskDueDate('2024-02-29', 'ANNUAL')).toBe('2025-03-01');
  });
});
