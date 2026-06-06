// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0121 — zod validation for reminder schedules. Kept separate from
// ./reminders so the worker (which imports the reminder tick → ./reminders)
// doesn't pull zod into its bundle. Imported only by the API routes.

import { z } from 'zod';

import { REMINDER_CHANNELS } from './reminders';

/** Max offset = 14 days before start; min = 5 minutes. */
export const ReminderStepSchema = z.object({
  offsetMinutes: z.number().int().min(5).max(20160),
  channel: z.enum(REMINDER_CHANNELS),
});

/** A whole schedule (max 10 steps). Used by the type + booking routes. */
export const ReminderScheduleSchema = z.array(ReminderStepSchema).max(10);
