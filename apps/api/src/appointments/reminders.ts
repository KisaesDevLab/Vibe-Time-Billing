// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0121 — appointment reminder schedules. A schedule is a list of steps
// { offsetMinutes (before start), channel }. It can live on an appointment
// type (default) or an appointment (per-booking override). This module owns
// the shared type, validation, UI presets, and the resolution precedence so
// the routes, the reminder tick, and the UIs all agree.

import { z } from 'zod';

import type { ReminderStep } from '@vibe/db/schema';

export type { ReminderStep };
export type ReminderChannel = ReminderStep['channel'];

export const REMINDER_CHANNELS = ['EMAIL', 'SMS', 'CALL'] as const;

/** Max offset = 14 days before start; min = 5 minutes. */
export const ReminderStepSchema = z.object({
  offsetMinutes: z.number().int().min(5).max(20160),
  channel: z.enum(REMINDER_CHANNELS),
});

/** A whole schedule (max 10 steps). Used by both the type + booking routes. */
export const ReminderScheduleSchema = z.array(ReminderStepSchema).max(10);

/** Friendly offset presets for the editor UIs. */
export const OFFSET_PRESETS: { label: string; minutes: number }[] = [
  { label: '1 week before', minutes: 10080 },
  { label: '3 days before', minutes: 4320 },
  { label: '1 day before', minutes: 1440 },
  { label: '2 hours before', minutes: 120 },
  { label: '1 hour before', minutes: 60 },
  { label: '30 minutes before', minutes: 30 },
];

function isSchedule(v: unknown): v is ReminderStep[] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as ReminderStep).offsetMinutes === 'number' &&
        REMINDER_CHANNELS.includes((s as ReminderStep).channel),
    )
  );
}

/**
 * Resolve the effective schedule for an appointment, in precedence order:
 *   1. the appointment's own override (if set),
 *   2. else the appointment type's default (if set),
 *   3. else the firm's legacy email offsets mapped to EMAIL steps.
 * Returns a normalized, de-duplicated list.
 */
export function resolveSchedule(
  appointmentSchedule: unknown,
  typeSchedule: unknown,
  firmOffsetsMinutes: number[],
): ReminderStep[] {
  let steps: ReminderStep[];
  if (isSchedule(appointmentSchedule) && appointmentSchedule.length > 0) {
    steps = appointmentSchedule;
  } else if (isSchedule(typeSchedule) && typeSchedule.length > 0) {
    steps = typeSchedule;
  } else {
    steps = firmOffsetsMinutes.map((m) => ({ offsetMinutes: m, channel: 'EMAIL' as const }));
  }
  // De-dup identical (offset, channel) pairs; keep positive offsets only.
  const seen = new Set<string>();
  const out: ReminderStep[] = [];
  for (const s of steps) {
    if (!Number.isFinite(s.offsetMinutes) || s.offsetMinutes <= 0) continue;
    const key = `${s.offsetMinutes}:${s.channel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ offsetMinutes: s.offsetMinutes, channel: s.channel });
  }
  return out;
}
