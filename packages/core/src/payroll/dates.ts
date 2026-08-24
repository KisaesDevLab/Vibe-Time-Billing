// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Pure ISO-date (YYYY-MM-DD) arithmetic for payroll math. time_entry
// dates are Postgres `date`s, so everything here is calendar math with
// no timezone component — Date objects are used UTC-only as an epoch-day
// intermediate.

import type { IsoDate } from '@vibe/types';

export function toEpochDays(d: IsoDate): number {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  return Math.floor(Date.UTC(y, m - 1, day) / 86_400_000);
}

export function fromEpochDays(days: number): IsoDate {
  const dt = new Date(days * 86_400_000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromEpochDays(toEpochDays(d) + n);
}

/** b - a in whole days. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return toEpochDays(b) - toEpochDays(a);
}

/** 0=Sunday..6=Saturday, matching firm_settings.payroll_workweek_start_day. */
export function dayOfWeek(d: IsoDate): number {
  return new Date(toEpochDays(d) * 86_400_000).getUTCDay();
}

export function lastDayOfMonth(year: number, month1: number): IsoDate {
  const last = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  return `${year}-${String(month1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

export function yearOf(d: IsoDate): number {
  return Number(d.slice(0, 4));
}

export function monthOf(d: IsoDate): number {
  return Number(d.slice(5, 7));
}

export function dayOf(d: IsoDate): number {
  return Number(d.slice(8, 10));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
