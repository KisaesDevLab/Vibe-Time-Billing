// SPDX-License-Identifier: Elastic-2.0
//
// Recurring-task date math. When a recurring task is completed the app opens
// its successor with the next due date; this computes that date. Mirrors the
// recurring-billing `nextRunDate` but adds SEMIMONTHLY (twice a month), which
// billing does not have.

import type { IsoDate } from '@vibe/types';

export type TaskRecurrence =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'SEMIMONTHLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL';

/**
 * Roll a due date forward by one recurrence step. UTC throughout so it never
 * drifts across timezones; returns an ISO `YYYY-MM-DD` string.
 *
 * SEMIMONTHLY is anchored to the 1st & 15th (payroll-style): days 1–14 advance
 * to the 15th, the 15th onward advances to the 1st of the next month.
 */
export function nextTaskDueDate(current: IsoDate, frequency: TaskRecurrence): IsoDate {
  const d = new Date(`${current}T00:00:00Z`);
  switch (frequency) {
    case 'WEEKLY':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'BIWEEKLY':
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case 'SEMIMONTHLY':
      // Anchored to the 1st & 15th: days 1–14 advance to the 15th of the same
      // month; the 15th onward advances to the 1st of the next month.
      if (d.getUTCDate() < 15) {
        d.setUTCDate(15);
      } else {
        d.setUTCMonth(d.getUTCMonth() + 1);
        d.setUTCDate(1);
      }
      break;
    case 'MONTHLY':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case 'QUARTERLY':
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    case 'SEMIANNUAL':
      d.setUTCMonth(d.getUTCMonth() + 6);
      break;
    case 'ANNUAL':
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      break;
  }
  return d.toISOString().slice(0, 10);
}
