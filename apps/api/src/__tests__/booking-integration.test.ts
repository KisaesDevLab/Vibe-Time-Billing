// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// BK-8 — integration: book → (inline) per-staff calendar write +
// confirmation email → cancel → calendar delete + cancellation email.
// The BookingQueue is wired to run the BK-5/BK-6 jobs synchronously so
// the whole chain exercises real DB + write-service + email render.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RoleSlug } from '@vibe/core/rbac';
import {
  appointmentStaff,
  appointments,
  calendarEvents,
  calendarProviderConfig,
  staffAvailability,
  staffBookingSettings,
  staffCalendarConnections,
  staffCalendarSelections,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { newCalendarRecordKey, encField } from '../calendar/crypto';
import { createBookingRouter } from '../appointments/booking-routes';
import { createAppointmentRouter } from '../appointments/routes';
import type { BookingQueue } from '../appointments/queue';
import { findBookingConflict, type StaffBusyProvider } from '../appointments/availability';
import {
  runAppointmentProviderWrite,
  runAppointmentProviderDelete,
} from '../appointments/provider-jobs';
import {
  runAppointmentConfirmationSend,
  runAppointmentCancellationSend,
  runAppointmentDeclineSend,
  runAppointmentRescheduleRequestedStaffSend,
  type AppointmentMail,
} from '../appointments/email-jobs';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

const MONDAY = '2030-01-07';
const mails: AppointmentMail[] = [];

const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? 'GET';
  if (u.includes('/calendar/v3/calendars/') && u.includes('/events')) {
    if (method === 'POST')
      return new Response(JSON.stringify({ id: 'g-1', htmlLink: 'x', etag: '"e"' }), {
        status: 200,
      });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (method === 'PATCH')
      return new Response(JSON.stringify({ id: 'g-1', htmlLink: 'x', etag: '"e2"' }), {
        status: 200,
      });
  }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

const fakeBusy: StaffBusyProvider = {
  async getBusy() {
    return [];
  },
};

// Queue that runs the real BK-5/BK-6 jobs inline (no Redis/worker).
function inlineQueue(): BookingQueue {
  const deps = { db: harness.db, fetchImpl: mockFetch };
  const email = { db: harness.db, sendEmail: async (m: AppointmentMail) => void mails.push(m) };
  return {
    async providerWrite(j) {
      await runAppointmentProviderWrite(deps, j);
    },
    async providerUpdate(j) {
      await runAppointmentProviderWrite(deps, j);
    },
    async providerDelete(j) {
      await runAppointmentProviderDelete(deps, j);
    },
    async confirmationSend(j) {
      await runAppointmentConfirmationSend(email, j);
    },
    async rescheduleConfirmationSend(j) {
      await runAppointmentConfirmationSend(email, j);
    },
    async cancellationSend(j) {
      await runAppointmentCancellationSend(email, j);
    },
    async declineSend(j) {
      await runAppointmentDeclineSend(email, j);
    },
    async rescheduleRequestedStaffSend(j) {
      await runAppointmentRescheduleRequestedStaffSend(email, j);
    },
  };
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const fakeUserRoles = new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]);
  a.use(
    '/api/staff/appointments',
    createBookingRouter({
      db: harness.db,
      fakeUserRoles,
      queue: inlineQueue(),
      busyProvider: fakeBusy,
      now: () => new Date('2030-01-01T00:00:00Z'),
    }),
  );
  a.use('/api/staff/appointments', createAppointmentRouter({ db: harness.db, fakeUserRoles }));
  return a;
}

async function seedWriteConnection(): Promise<void> {
  const pc = newCalendarRecordKey(harness.db, seed.firmId);
  await harness.db.insert(calendarProviderConfig).values({
    firmId: seed.firmId,
    provider: 'google',
    tDekWrapped: Buffer.from(pc.wrappedDek),
    clientIdEnc: encField(pc.dek, 'cid')!,
    clientSecretEnc: encField(pc.dek, 'csec')!,
    enabled: true,
  });
  const ck = newCalendarRecordKey(harness.db, seed.firmId);
  const [conn] = await harness.db
    .insert(staffCalendarConnections)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      provider: 'google',
      tDekWrapped: Buffer.from(ck.wrappedDek),
      accessTokenEnc: encField(ck.dek, 'acc')!,
      refreshTokenEnc: encField(ck.dek, 'ref'),
      tokenExpiry: new Date('2031-01-01T00:00:00Z'),
      scope: 'https://www.googleapis.com/auth/calendar.events',
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
}

beforeEach(async () => {
  mails.length = 0;
  process.env['FEATURE_CALENDAR_WRITE'] = 'true';
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-bk8-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  await harness.db.execute(sql`UPDATE office SET timezone = 'UTC' WHERE firm_id = ${seed.firmId}`);
  await harness.db
    .insert(staffBookingSettings)
    .values({ staffId: seed.appUserId, minNoticeHours: 0, slotIncrementMinutes: 60 });
  await harness.db
    .insert(staffAvailability)
    .values({ staffId: seed.appUserId, dayOfWeek: 1, startTime: '09:00', endTime: '17:00' });
  await seedWriteConnection();
});
afterEach(async () => {
  delete process.env['FEATURE_CALENDAR_WRITE'];
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('booking integration (book → write + email → cancel)', () => {
  it('runs the full chain', async () => {
    const { contactId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Jane Client',
      email: 'jane@client.example',
    });
    const a = app();
    const create = await request(a)
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'Tax Review',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
        durationMinutes: 60,
        clientId: seed.clientId,
        participantContactIds: [contactId],
      });
    expect(create.status).toBe(201);
    const apptId = create.body.id as string;

    // Provider write ran inline → mirror + written status.
    const [staffRow] = await harness.db
      .select()
      .from(appointmentStaff)
      .where(eq(appointmentStaff.appointmentId, apptId));
    expect(staffRow!.providerWriteStatus).toBe('written');
    const mirror = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, staffRow!.calendarEventId!));
    expect(mirror).toHaveLength(1);
    // Confirmation email sent to the participant.
    expect(
      mails.some((m) => m.to === 'jane@client.example' && m.subject.includes('Tax Review')),
    ).toBe(true);

    // Cancel → provider delete + cancellation email.
    mails.length = 0;
    const cancel = await request(a)
      .post(`/api/staff/appointments/${apptId}/cancel`)
      .send({ reason: 'done' });
    expect(cancel.status).toBe(200);
    const [appt] = await harness.db.select().from(appointments).where(eq(appointments.id, apptId));
    expect(appt!.status).toBe('CANCELLED');
    const [m2] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, staffRow!.calendarEventId!));
    expect(m2!.softDeletedAt).not.toBeNull();
    expect(mails.some((m) => m.ics?.includes('METHOD:CANCEL'))).toBe(true);
  });
});

describe('final double-booking guard', () => {
  function book(start: string, end: string) {
    return request(app())
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'X',
        startsAt: `${MONDAY}T${start}:00.000Z`,
        endsAt: `${MONDAY}T${end}:00.000Z`,
        durationMinutes: 60,
      });
  }
  const at = (t: string): Date => new Date(`${MONDAY}T${t}:00.000Z`);

  it('findBookingConflict: overlap yes, back-to-back no, cancelled/other-staff/self ignored', async () => {
    const created = await book('09:00', '10:00');
    expect(created.status).toBe(201);
    const apptId = created.body.id as string;

    expect(await findBookingConflict(harness.db, [seed.appUserId], at('09:30'), at('10:30'))).toBe(
      true,
    );
    // Back-to-back (ends exactly when the next starts) must NOT conflict.
    expect(await findBookingConflict(harness.db, [seed.appUserId], at('10:00'), at('11:00'))).toBe(
      false,
    );
    expect(await findBookingConflict(harness.db, [seed.appUserId], at('08:00'), at('09:00'))).toBe(
      false,
    );
    // Excluding the appointment itself (reschedule case) → no conflict.
    expect(
      await findBookingConflict(harness.db, [seed.appUserId], at('09:00'), at('10:00'), apptId),
    ).toBe(false);
    // A different staff member is free.
    expect(
      await findBookingConflict(
        harness.db,
        ['00000000-0000-0000-0000-000000000000'],
        at('09:30'),
        at('10:30'),
      ),
    ).toBe(false);
    // Cancelling clears the conflict.
    await harness.db
      .update(appointments)
      .set({ status: 'CANCELLED' })
      .where(eq(appointments.id, apptId));
    expect(await findBookingConflict(harness.db, [seed.appUserId], at('09:30'), at('10:30'))).toBe(
      false,
    );
  });

  it('POST /book refuses to double-book a taken slot (409 slot_taken)', async () => {
    expect((await book('09:00', '10:00')).status).toBe(201);
    const dup = await book('09:00', '10:00');
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('slot_taken');
  });
});
