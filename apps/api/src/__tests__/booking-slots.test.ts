// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-2 — multi-staff slot availability engine. 14 named cases covering
// single + multi-staff intersection, buffers, notice, increment, busy
// merging, boundaries, DST, and the provider→calendar_events fallback.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  calendarEvents,
  calendarProviderConfig,
  staffAvailability,
  staffBookingSettings,
  staffCalendarConnections,
  staffCalendarSelections,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import {
  getAvailableSlots,
  type BusyInterval,
  type StaffBusyProvider,
} from '../appointments/availability';
import { createFreeBusyProvider } from '../calendar/freebusy';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { newCalendarRecordKey, encField } from '../calendar/crypto';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

const MONDAY = '2030-01-07'; // a Monday; UTC unless a test passes another tz
const FAR_BEFORE = new Date('2030-01-01T00:00:00Z');

function dow(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

async function addStaff(email: string): Promise<string> {
  const { sql } = await import('drizzle-orm');
  const r = await harness.db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${seed.firmId}, ${email}, ${email}, 'X', 'Y') RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function setAvail(staffId: string, date: string, start: string, end: string): Promise<void> {
  await harness.db
    .insert(staffAvailability)
    .values({ staffId, dayOfWeek: dow(date), startTime: start, endTime: end, isActive: true });
}

async function setSettings(
  staffId: string,
  s: Partial<{
    bufferBeforeMinutes: number;
    bufferAfterMinutes: number;
    minNoticeHours: number;
    slotIncrementMinutes: number;
  }>,
): Promise<void> {
  await harness.db
    .insert(staffBookingSettings)
    .values({ staffId, minNoticeHours: 0, ...s })
    .onConflictDoUpdate({
      target: staffBookingSettings.staffId,
      set: { minNoticeHours: 0, ...s },
    });
}

function fakeBusy(map: Record<string, BusyInterval[]>): StaffBusyProvider {
  return {
    async getBusy(staffId) {
      return map[staffId] ?? [];
    },
  };
}

const I = (d: string, t1: string, t2: string): BusyInterval => ({
  start: new Date(`${d}T${t1}:00Z`),
  end: new Date(`${d}T${t2}:00Z`),
});

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-bk-slots-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('getAvailableSlots — single staff', () => {
  it('1. normal day with 3 busy blocks → correct slots', async () => {
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 30 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 30,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({
        [a]: [
          I(MONDAY, '09:30', '10:00'),
          I(MONDAY, '10:30', '11:00'),
          I(MONDAY, '11:30', '12:00'),
        ],
      }),
    });
    const avail = res.slots.filter((s) => s.available).map((s) => s.start);
    expect(avail).toEqual([
      `${MONDAY}T09:00:00.000Z`,
      `${MONDAY}T10:00:00.000Z`,
      `${MONDAY}T11:00:00.000Z`,
    ]);
  });

  it('2. buffer before/after excludes adjacent slots', async () => {
    const a = seed.appUserId;
    await setSettings(a, {
      slotIncrementMinutes: 30,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
    });
    await setAvail(a, MONDAY, '09:00', '12:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 30,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({ [a]: [I(MONDAY, '10:00', '10:30')] }),
    });
    const avail = res.slots.filter((s) => s.available).map((s) => s.start);
    expect(avail).toContain(`${MONDAY}T09:00:00.000Z`);
    expect(avail).not.toContain(`${MONDAY}T09:30:00.000Z`); // buffer-after into 10:00 busy
    expect(avail).not.toContain(`${MONDAY}T10:30:00.000Z`); // buffer-before into 10:30 busy
  });

  it('3. day not in availability → empty (staff_unavailable)', async () => {
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 30 });
    // availability set for a DIFFERENT day only
    const sunday = '2030-01-06';
    await setAvail(a, sunday, '09:00', '17:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 30,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    expect(res.slots).toHaveLength(0);
    expect(res.reason).toBe('staff_unavailable');
    expect(res.staffId).toBe(a);
  });

  it('4. within notice period → empty (within_notice)', async () => {
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 30, minNoticeHours: 24 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 30,
      timezone: 'UTC',
      now: new Date(`${MONDAY}T08:00:00Z`), // same morning, 24h notice → nothing today
      busyProvider: fakeBusy({}),
    });
    expect(res.slots).toHaveLength(0);
    expect(res.reason).toBe('within_notice');
  });

  it('12. end-of-day boundary slot excluded', async () => {
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 30 });
    await setAvail(a, MONDAY, '09:00', '10:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    // Only 09:00-10:00 fits; 09:30-10:30 would exceed the window.
    expect(res.slots.map((s) => s.start)).toEqual([`${MONDAY}T09:00:00.000Z`]);
  });

  it('14. duration > increment (90-min duration, 30-min increment)', async () => {
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 30 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 90,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    // 90-min slots stepping by 30: 09:00,09:30,10:00,10:30 (end<=12:00).
    expect(res.slots.map((s) => s.start)).toEqual([
      `${MONDAY}T09:00:00.000Z`,
      `${MONDAY}T09:30:00.000Z`,
      `${MONDAY}T10:00:00.000Z`,
      `${MONDAY}T10:30:00.000Z`,
    ]);
    expect(res.slots.every((s) => s.durationMinutes === 90)).toBe(true);
  });
});

describe('getAvailableSlots — multi-staff intersection', () => {
  it('5. both free → slot appears', async () => {
    const a = seed.appUserId;
    const b = await addStaff('b@test.example');
    await setSettings(a, { slotIncrementMinutes: 60 });
    await setSettings(b, { slotIncrementMinutes: 60 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    await setAvail(b, MONDAY, '09:00', '12:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a, b],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    const first = res.slots.find((s) => s.start === `${MONDAY}T09:00:00.000Z`);
    expect(first?.available).toBe(true);
    expect(first?.staffAvailability.every((p) => p.free)).toBe(true);
  });

  it('6. one staff busy → slot blocked; pips show who is busy', async () => {
    const a = seed.appUserId;
    const b = await addStaff('b6@test.example');
    await setSettings(a, { slotIncrementMinutes: 60 });
    await setSettings(b, { slotIncrementMinutes: 60 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    await setAvail(b, MONDAY, '09:00', '12:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a, b],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({ [b]: [I(MONDAY, '09:00', '10:00')] }),
    });
    const first = res.slots.find((s) => s.start === `${MONDAY}T09:00:00.000Z`)!;
    expect(first.available).toBe(false);
    expect(first.staffAvailability.find((p) => p.staffId === a)!.free).toBe(true);
    expect(first.staffAvailability.find((p) => p.staffId === b)!.free).toBe(false);
  });

  it('7. strictest (largest) buffer applied across staff', async () => {
    const a = seed.appUserId;
    const b = await addStaff('b7@test.example');
    await setSettings(a, { slotIncrementMinutes: 30, bufferAfterMinutes: 15 });
    await setSettings(b, { slotIncrementMinutes: 30, bufferAfterMinutes: 30 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    await setAvail(b, MONDAY, '09:00', '12:00');
    // Busy on A at 10:45-11:15. Slot 10:00-10:30 + 30-min after-buffer → 11:00,
    // overlaps busy. With only 15 (A's own) it would NOT overlap.
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a, b],
      date: MONDAY,
      durationMinutes: 30,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({ [a]: [I(MONDAY, '10:45', '11:15')] }),
    });
    const slot = res.slots.find((s) => s.start === `${MONDAY}T10:00:00.000Z`)!;
    expect(slot.available).toBe(false);
  });

  it('8. strictest (largest) notice applied across staff', async () => {
    const a = seed.appUserId;
    const b = await addStaff('b8@test.example');
    await setSettings(a, { slotIncrementMinutes: 60, minNoticeHours: 1 });
    await setSettings(b, { slotIncrementMinutes: 60, minNoticeHours: 24 });
    await setAvail(a, MONDAY, '09:00', '17:00');
    await setAvail(b, MONDAY, '09:00', '17:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a, b],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: new Date(`${MONDAY}T08:00:00Z`), // 24h notice (B) wipes the whole day
      busyProvider: fakeBusy({}),
    });
    expect(res.slots).toHaveLength(0);
    expect(res.reason).toBe('within_notice');
  });

  it('9. one staff has no availability row for the day → early empty', async () => {
    const a = seed.appUserId;
    const b = await addStaff('b9@test.example');
    await setSettings(a, { slotIncrementMinutes: 60 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    // b has NO availability for Monday
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a, b],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    expect(res.slots).toHaveLength(0);
    expect(res.reason).toBe('staff_unavailable');
    expect(res.staffId).toBe(b);
  });

  it('11. existing TB appointment_staff booking counts as busy', async () => {
    const { sql } = await import('drizzle-orm');
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 60 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    const appt = await harness.db.execute(
      sql`INSERT INTO appointment (firm_id, client_id, title, starts_at, ends_at, status, lead_app_user_id)
          VALUES (${seed.firmId}, ${seed.clientId}, 'Booked', ${`${MONDAY}T09:00:00Z`}, ${`${MONDAY}T10:00:00Z`}, 'SCHEDULED', ${a})
          RETURNING id`,
    );
    const apptId = (appt as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO appointment_staff (appointment_id, staff_id) VALUES (${apptId}, ${a})`,
    );
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    const first = res.slots.find((s) => s.start === `${MONDAY}T09:00:00.000Z`)!;
    expect(first.available).toBe(false); // blocked by the existing booking
  });
});

describe('getAvailableSlots — timezone / DST', () => {
  it('13. wall-clock honors the zone offset (EST vs EDT)', async () => {
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 60 });
    // Winter Monday (EST, UTC-5): 09:00 ET → 14:00Z
    await setAvail(a, MONDAY, '09:00', '12:00');
    const winter = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'America/New_York',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    expect(winter.slots[0]?.start).toBe(`${MONDAY}T14:00:00.000Z`);

    // Summer Monday (EDT, UTC-4): 09:00 ET → 13:00Z
    const summer = '2030-07-08';
    await setAvail(a, summer, '09:00', '12:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: summer,
      durationMinutes: 60,
      timezone: 'America/New_York',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    expect(res.slots[0]?.start).toBe(`${summer}T13:00:00.000Z`);
  });
});

describe('createFreeBusyProvider — fallback', () => {
  it('10. provider call fails → falls back to calendar_events', async () => {
    // Bootstrap firm crypto so we can seed an encrypted connection.
    await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
    setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 60 });
    await setAvail(a, MONDAY, '09:00', '12:00');

    // A connected Google calendar whose provider call will throw.
    const { dek, wrappedDek } = newCalendarRecordKey(harness.db, seed.firmId);
    await harness.db.insert(calendarProviderConfig).values({
      firmId: seed.firmId,
      provider: 'google',
      tDekWrapped: Buffer.from(wrappedDek),
      clientIdEnc: encField(dek, 'cid')!,
      clientSecretEnc: encField(dek, 'csec')!,
      enabled: true,
    });
    const ck = newCalendarRecordKey(harness.db, seed.firmId);
    const [conn] = await harness.db
      .insert(staffCalendarConnections)
      .values({
        firmId: seed.firmId,
        staffId: a,
        provider: 'google',
        tDekWrapped: Buffer.from(ck.wrappedDek),
        accessTokenEnc: encField(ck.dek, 'acc')!,
        refreshTokenEnc: encField(ck.dek, 'ref'),
        tokenExpiry: new Date('2031-01-01T00:00:00Z'),
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
        enabled: true,
      })
      .returning({ id: staffCalendarConnections.id });
    await harness.db.insert(staffCalendarSelections).values({
      connectionId: conn!.id,
      calendarId: 'primary',
      calendarName: 'Work',
      isPrimary: true,
      syncEnabled: true,
    });
    // Ingested event (the fallback source) marks 09:00-10:00 busy.
    await harness.db.insert(calendarEvents).values({
      firmId: seed.firmId,
      staffId: a,
      connectionId: conn!.id,
      providerEventId: 'ev-1',
      calendarId: 'primary',
      subject: 'Busy',
      startAt: new Date(`${MONDAY}T09:00:00Z`),
      endAt: new Date(`${MONDAY}T10:00:00Z`),
    });

    const throwingFetch: typeof fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const provider = createFreeBusyProvider({
      db: harness.db,
      firmId: seed.firmId,
      fetchImpl: throwingFetch,
    });
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: provider,
    });
    const first = res.slots.find((s) => s.start === `${MONDAY}T09:00:00.000Z`)!;
    expect(first.available).toBe(false); // calendar_events busy applied via fallback
    const ten = res.slots.find((s) => s.start === `${MONDAY}T10:00:00.000Z`)!;
    expect(ten.available).toBe(true);
  });
});

// ---- QA regression cases (post-review hardening) --------------------
describe('getAvailableSlots — QA hardening', () => {
  it('bookingEnabled=false → not bookable (staff_unavailable)', async () => {
    const a = seed.appUserId;
    await harness.db
      .insert(staffBookingSettings)
      .values({ staffId: a, minNoticeHours: 0, slotIncrementMinutes: 60, bookingEnabled: false });
    await setAvail(a, MONDAY, '09:00', '12:00');
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({}),
    });
    expect(res.slots).toHaveLength(0);
    expect(res.reason).toBe('staff_unavailable');
  });

  it('reschedule excludes the appointment’s own busy + matching provider block', async () => {
    const { sql } = await import('drizzle-orm');
    const a = seed.appUserId;
    await setSettings(a, { slotIncrementMinutes: 60 });
    await setAvail(a, MONDAY, '09:00', '12:00');
    const appt = await harness.db.execute(
      sql`INSERT INTO appointment (firm_id, client_id, title, starts_at, ends_at, status, lead_app_user_id)
          VALUES (${seed.firmId}, ${seed.clientId}, 'Self', ${`${MONDAY}T09:00:00Z`}, ${`${MONDAY}T10:00:00Z`}, 'SCHEDULED', ${a})
          RETURNING id`,
    );
    const apptId = (appt as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await harness.db.execute(
      sql`INSERT INTO appointment_staff (appointment_id, staff_id) VALUES (${apptId}, ${a})`,
    );
    // Provider also reports the same window busy (the appt's own event).
    const res = await getAvailableSlots({
      db: harness.db,
      staffIds: [a],
      date: MONDAY,
      durationMinutes: 60,
      timezone: 'UTC',
      now: FAR_BEFORE,
      busyProvider: fakeBusy({ [a]: [I(MONDAY, '09:00', '10:00')] }),
      excludeAppointmentId: apptId,
    });
    const nine = res.slots.find((s) => s.start === `${MONDAY}T09:00:00.000Z`)!;
    expect(nine.available).toBe(true); // own booking + matching provider block excluded
  });
});
