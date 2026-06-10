// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-2 — Multi-staff slot availability engine. Computes bookable slots
// for one or more staff on a given calendar date: the INTERSECTION of
// every selected staff member's working hours (staff_availability) and
// free time (provider free/busy + existing TB bookings), applying the
// STRICTEST notice + the LARGEST buffers across the selected staff.
//
// A single staff member is just the 1-element intersection.
//
// Timezone: availability hours are wall-clock in the firm's (office)
// timezone; we convert (date, HH:MM) → UTC instants via Intl so DST is
// handled without a tz library.

import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appointmentStaff,
  appointments,
  staffAvailability,
  staffBookingSettings,
} from '@vibe/db/schema';

export interface BusyInterval {
  start: Date;
  end: Date;
}

/** Resolves busy time for a staff member over a window (provider free/busy
 *  with a calendar_events fallback — see freebusy.ts). Injectable so the
 *  slot engine is unit-testable without hitting providers. */
export interface StaffBusyProvider {
  getBusy(staffId: string, start: Date, end: Date): Promise<BusyInterval[]>;
}

export interface SlotStaffPip {
  staffId: string;
  free: boolean;
}

export interface Slot {
  start: string; // ISO
  end: string; // ISO
  durationMinutes: number;
  /** True when every selected staff member is free for this slot. */
  available: boolean;
  staffAvailability: SlotStaffPip[];
}

export interface AvailabilityResult {
  slots: Slot[];
  timezone: string;
  date: string;
  /** Set when the result is empty for a structural reason. */
  reason?: 'staff_unavailable' | 'within_notice';
  /** The staff member that triggered `staff_unavailable`. */
  staffId?: string;
}

export interface GetAvailableSlotsArgs {
  db: Database;
  staffIds: string[];
  date: string; // YYYY-MM-DD
  durationMinutes: number;
  timezone: string;
  now?: Date;
  /** Defaults to the real provider; tests inject a fake. */
  busyProvider: StaffBusyProvider;
  /** Exclude this appointment from the booking-busy set (reschedule). */
  excludeAppointmentId?: string;
  /** When set, only availability windows that allow this meeting location
   *  (VIDEO | PHONE | IN_PERSON) are considered. */
  location?: string;
  /** When set, only availability windows tied to this saved location preset
   *  (or windows with no preset, which are location-agnostic) are considered. */
  locationOptionId?: string;
}

/** A window allows a location when it has no restriction (null/empty) or its
 *  list includes the requested location. No requested location → allow all. */
function windowAllowsLocation(
  locationTypes: string[] | null | undefined,
  location: string | undefined,
): boolean {
  if (!location) return true;
  if (!locationTypes || locationTypes.length === 0) return true;
  return locationTypes.includes(location);
}

/** A window matches a saved location preset when no preset is requested
 *  (not filtering), or the window has no preset (location-agnostic), or the
 *  window's preset equals the requested one. */
function windowAllowsLocationOption(
  windowOptionId: string | null | undefined,
  requestedOptionId: string | undefined,
): boolean {
  if (!requestedOptionId) return true;
  if (!windowOptionId) return true;
  return windowOptionId === requestedOptionId;
}

interface ResolvedSettings {
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeHours: number;
  slotIncrementMinutes: number;
  bookingEnabled: boolean;
}

const DEFAULT_SETTINGS: ResolvedSettings = {
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeHours: 1,
  slotIncrementMinutes: 30,
  bookingEnabled: true,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN = 60_000;

// ---- timezone helpers ------------------------------------------------

/** Offset (ms) of `tz` at the given instant: tzWallClock - utc. */
function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - at.getTime();
}

/** Convert a wall-clock (date, HH:MM) in `tz` to a UTC instant. */
function wallClockToUtc(date: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const naiveUtc = Date.UTC(y, mo - 1, d, h, mi, 0);
  // Two-pass: estimate offset, then correct (handles the common DST case).
  const off1 = tzOffsetMs(new Date(naiveUtc), tz);
  const off2 = tzOffsetMs(new Date(naiveUtc - off1), tz);
  return new Date(naiveUtc - off2);
}

function dayOfWeek(date: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

interface Window {
  start: Date;
  end: Date;
}

/**
 * Compute the bookable slots for `staffIds` on `date` for a meeting of
 * `durationMinutes`. See file header for the intersection semantics.
 */
export async function getAvailableSlots(args: GetAvailableSlotsArgs): Promise<AvailabilityResult> {
  const { db, staffIds, date, durationMinutes, timezone, busyProvider } = args;
  const now = args.now ?? new Date();
  const empty = (extra: Partial<AvailabilityResult> = {}): AvailabilityResult => ({
    slots: [],
    timezone,
    date,
    ...extra,
  });

  if (!DATE_RE.test(date) || staffIds.length === 0 || durationMinutes <= 0) return empty();

  const dow = dayOfWeek(date);

  // Load settings + availability per staff.
  const settingsRows = await db
    .select()
    .from(staffBookingSettings)
    .where(inArray(staffBookingSettings.staffId, staffIds));
  const availRows = await db
    .select()
    .from(staffAvailability)
    .where(and(inArray(staffAvailability.staffId, staffIds), eq(staffAvailability.dayOfWeek, dow)));

  const settingsByStaff = new Map<string, ResolvedSettings>();
  for (const id of staffIds) {
    const row = settingsRows.find((r) => r.staffId === id);
    settingsByStaff.set(id, row ? { ...DEFAULT_SETTINGS, ...stripNulls(row) } : DEFAULT_SETTINGS);
  }

  // Each staff's working windows (UTC) for this day. A staff with no
  // active row for the day short-circuits the whole intersection.
  const windowsByStaff = new Map<string, Window[]>();
  for (const id of staffIds) {
    // A staff member who turned booking off is not bookable at all.
    if (!settingsByStaff.get(id)!.bookingEnabled) {
      return empty({ reason: 'staff_unavailable', staffId: id });
    }
    const rows = availRows.filter(
      (r) =>
        r.staffId === id &&
        r.isActive &&
        windowAllowsLocation(r.locationTypes, args.location) &&
        windowAllowsLocationOption(r.locationOptionId, args.locationOptionId),
    );
    if (rows.length === 0) return empty({ reason: 'staff_unavailable', staffId: id });
    windowsByStaff.set(
      id,
      rows.map((r) => ({
        start: wallClockToUtc(date, r.startTime.slice(0, 5), timezone),
        end: wallClockToUtc(date, r.endTime.slice(0, 5), timezone),
      })),
    );
  }

  // Strictest increment (smallest), largest buffers, strictest notice (largest).
  let increment = Infinity;
  let maxBefore = 0;
  let maxAfter = 0;
  let maxNotice = 0;
  for (const id of staffIds) {
    const s = settingsByStaff.get(id)!;
    increment = Math.min(increment, s.slotIncrementMinutes);
    maxBefore = Math.max(maxBefore, s.bufferBeforeMinutes);
    maxAfter = Math.max(maxAfter, s.bufferAfterMinutes);
    maxNotice = Math.max(maxNotice, s.minNoticeHours);
  }
  if (!isFinite(increment) || increment <= 0) increment = 30;
  const noticeCutoff = new Date(now.getTime() + maxNotice * 60 * MIN);

  // Grid bounds = union of all windows; candidates step by the increment.
  let gridMin = Infinity;
  let gridMax = -Infinity;
  for (const wins of windowsByStaff.values()) {
    for (const w of wins) {
      gridMin = Math.min(gridMin, w.start.getTime());
      gridMax = Math.max(gridMax, w.end.getTime());
    }
  }
  if (!isFinite(gridMin) || !isFinite(gridMax)) return empty();

  // Busy intervals per staff: provider/calendar free-busy ∪ TB bookings.
  const windowStart = new Date(gridMin - maxBefore * MIN);
  const windowEnd = new Date(gridMax + maxAfter * MIN);
  const busyByStaff = new Map<string, BusyInterval[]>();
  const bookingBusy = await loadBookingBusy(
    db,
    staffIds,
    windowStart,
    windowEnd,
    args.excludeAppointmentId,
  );
  // On reschedule, the appointment's OWN provider/mirror event still shows
  // up in free/busy (getSchedule returns no ids to filter by); drop busy
  // intervals that exactly match the appointment's current window so it
  // doesn't block rescheduling to an overlapping time.
  let selfWindow: { start: number; end: number } | null = null;
  if (args.excludeAppointmentId) {
    const [self] = await db
      .select({ start: appointments.startsAt, end: appointments.endsAt })
      .from(appointments)
      .where(eq(appointments.id, args.excludeAppointmentId))
      .limit(1);
    if (self?.start && self.end) {
      selfWindow = { start: self.start.getTime(), end: self.end.getTime() };
    }
  }
  const isSelfEvent = (b: BusyInterval): boolean =>
    selfWindow !== null &&
    b.start.getTime() === selfWindow.start &&
    b.end.getTime() === selfWindow.end;

  for (const id of staffIds) {
    let busy: BusyInterval[] = [];
    try {
      busy = await busyProvider.getBusy(id, windowStart, windowEnd);
    } catch {
      busy = [];
    }
    busyByStaff.set(
      id,
      [...busy, ...(bookingBusy.get(id) ?? [])].filter((b) => !isSelfEvent(b)),
    );
  }

  const durMs = durationMinutes * MIN;
  const stepMs = increment * MIN;
  const slots: Slot[] = [];
  let noticeSkipped = 0;

  for (let t = gridMin; t + durMs <= gridMax + 1; t += stepMs) {
    const start = new Date(t);
    const end = new Date(t + durMs);
    // Must fit inside SOME window of EVERY staff.
    const withinAll = staffIds.every((id) =>
      windowsByStaff
        .get(id)!
        .some((w) => start.getTime() >= w.start.getTime() && end.getTime() <= w.end.getTime()),
    );
    if (!withinAll) continue;
    if (start.getTime() < noticeCutoff.getTime()) {
      noticeSkipped++;
      continue; // notice filter
    }

    const blockedStart = new Date(t - maxBefore * MIN);
    const blockedEnd = new Date(t + durMs + maxAfter * MIN);
    const pips: SlotStaffPip[] = staffIds.map((id) => {
      const free = !(busyByStaff.get(id) ?? []).some((b) =>
        overlaps(blockedStart, blockedEnd, b.start, b.end),
      );
      return { staffId: id, free };
    });
    slots.push({
      start: start.toISOString(),
      end: end.toISOString(),
      durationMinutes,
      available: pips.every((p) => p.free),
      staffAvailability: pips,
    });
  }

  // Only call it "within_notice" when the day actually had in-window
  // candidates that were filtered SOLELY by the notice window (not busy).
  if (slots.length === 0 && noticeSkipped > 0) {
    return empty({ reason: 'within_notice' });
  }
  return { slots, timezone, date };
}

/** TB bookings (scheduled appointments) per staff in the window count as busy. */
async function loadBookingBusy(
  db: Database,
  staffIds: string[],
  windowStart: Date,
  windowEnd: Date,
  excludeAppointmentId?: string,
): Promise<Map<string, BusyInterval[]>> {
  const conds = [
    inArray(appointmentStaff.staffId, staffIds),
    ne(appointments.status, 'CANCELLED'),
    lt(appointments.startsAt, windowEnd),
    gte(appointments.endsAt, windowStart),
  ];
  if (excludeAppointmentId) conds.push(ne(appointments.id, excludeAppointmentId));
  const rows = await db
    .select({
      staffId: appointmentStaff.staffId,
      start: appointments.startsAt,
      end: appointments.endsAt,
    })
    .from(appointmentStaff)
    .innerJoin(appointments, eq(appointments.id, appointmentStaff.appointmentId))
    .where(and(...conds));
  const out = new Map<string, BusyInterval[]>();
  for (const r of rows) {
    const list = out.get(r.staffId) ?? [];
    list.push({ start: r.start, end: r.end });
    out.set(r.staffId, list);
  }
  return out;
}

function stripNulls(row: {
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeHours: number;
  slotIncrementMinutes: number;
  bookingEnabled: boolean;
}): ResolvedSettings {
  return {
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    minNoticeHours: row.minNoticeHours,
    slotIncrementMinutes: row.slotIncrementMinutes,
    bookingEnabled: row.bookingEnabled,
  };
}

/** Month availability: which dates have at least one all-free slot. */
export async function getMonthAvailability(args: {
  db: Database;
  staffIds: string[];
  year: number;
  month: number; // 1-12
  durationMinutes: number;
  timezone: string;
  now?: Date;
  busyProvider: StaffBusyProvider;
  excludeAppointmentId?: string;
  location?: string;
  locationOptionId?: string;
}): Promise<{ days: Record<string, boolean>; timezone: string }> {
  const { db, staffIds, year, month, durationMinutes, timezone, busyProvider } = args;
  const now = args.now ?? new Date();
  const days: Record<string, boolean> = {};
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const res = await getAvailableSlots({
      db,
      staffIds,
      date,
      durationMinutes,
      timezone,
      now,
      busyProvider,
      excludeAppointmentId: args.excludeAppointmentId,
      location: args.location,
      locationOptionId: args.locationOptionId,
    });
    days[date] = res.slots.some((s) => s.available);
  }
  return { days, timezone };
}
