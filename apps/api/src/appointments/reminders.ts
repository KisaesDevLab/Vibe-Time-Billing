// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0121 — appointment reminder schedules. A schedule is a list of steps
// { offsetMinutes (before start), channel }. It can live on an appointment
// type (default) or an appointment (per-booking override). This module owns
// the shared type, validation, UI presets, and the resolution precedence so
// the routes, the reminder tick, and the UIs all agree.

import type { ReminderStep } from '@vibe/db/schema';

export type { ReminderStep };
export type ReminderChannel = ReminderStep['channel'];

export const REMINDER_CHANNELS = ['EMAIL', 'SMS', 'CALL'] as const;

// NOTE: zod validation lives in ./reminders-validation (routes only). This
// module stays zod-free so the worker — which imports it via the reminder
// tick — doesn't pull zod/config into its bundle.

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
