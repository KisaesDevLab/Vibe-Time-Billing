// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// BK-4 — multi-staff booking API: create (+ slot re-validation/409),
// engagement note, participants, reschedule, cancel, and the public
// token cancel / reschedule-request flows.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { RoleSlug } from '@vibe/core/rbac';
import {
  appointmentEngagementNotes,
  appointmentParticipants,
  appointmentRescheduleRequests,
  appointmentStaff,
  appointments,
  staffAvailability,
  staffBookingSettings,
  staffNotifications,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createBookingRouter } from '../appointments/booking-routes';
import { createAppointmentRouter } from '../appointments/routes';
import { createAppointmentPublicRouter } from '../appointments/public-routes';
import type { BusyInterval, StaffBusyProvider } from '../appointments/availability';
import type { BookingQueue } from '../appointments/queue';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const MONDAY = '2030-01-07';
const NOW = (): Date => new Date('2030-01-01T00:00:00Z');

function recorder(): { queue: BookingQueue; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    providerWrite: [],
    providerUpdate: [],
    providerDelete: [],
    confirmationSend: [],
    rescheduleConfirmationSend: [],
    cancellationSend: [],
  };
  const queue: BookingQueue = {
    async providerWrite(j) {
      calls.providerWrite!.push(j);
    },
    async providerUpdate(j) {
      calls.providerUpdate!.push(j);
    },
    async providerDelete(j) {
      calls.providerDelete!.push(j);
    },
    async confirmationSend(j) {
      calls.confirmationSend!.push(j);
    },
    async rescheduleConfirmationSend(j) {
      calls.rescheduleConfirmationSend!.push(j);
    },
    async cancellationSend(j) {
      calls.cancellationSend!.push(j);
    },
  };
  return { queue, calls };
}

function fakeBusy(map: Record<string, BusyInterval[]>): StaffBusyProvider {
  return {
    async getBusy(staffId) {
      return map[staffId] ?? [];
    },
  };
}

// A redis stub whose ops reject → the public rate-limiter fails open.
const fakeRedis = new Proxy(
  {},
  {
    get() {
      return async () => {
        throw new Error('no-redis');
      };
    },
  },
) as unknown as Redis;

async function addStaff(email: string): Promise<string> {
  const r = await harness.db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${seed.firmId}, ${email}, ${email}, 'X', 'Y') RETURNING id`,
  );
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

async function avail(staffId: string): Promise<void> {
  await harness.db
    .insert(staffBookingSettings)
    .values({ staffId, minNoticeHours: 0, slotIncrementMinutes: 60 })
    .onConflictDoNothing();
  await harness.db
    .insert(staffAvailability)
    .values({ staffId, dayOfWeek: 1, startTime: '09:00', endTime: '17:00', isActive: true }); // Monday
}

function buildApp(opts: {
  queue: BookingQueue;
  busyProvider: StaffBusyProvider;
  roles?: RoleSlug[];
}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const fakeUserRoles = new Map<string, RoleSlug[]>([[seed.appUserId, opts.roles ?? ['admin']]]);
  const deps = {
    db: harness.db,
    fakeUserRoles,
    queue: opts.queue,
    busyProvider: opts.busyProvider,
    now: NOW,
  };
  app.use('/api/staff/appointments', createBookingRouter(deps));
  app.use('/api/staff/appointments', createAppointmentRouter({ db: harness.db, fakeUserRoles }));
  app.use(
    '/api/public/appointments',
    createAppointmentPublicRouter({
      db: harness.db,
      redis: fakeRedis,
      queue: opts.queue,
      now: NOW,
    }),
  );
  return app;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  // Office tz → UTC so slot wall-clock == UTC for clean assertions.
  await harness.db.execute(sql`UPDATE office SET timezone = 'UTC' WHERE firm_id = ${seed.firmId}`);
  await avail(seed.appUserId);
});
afterEach(async () => {
  await harness.close();
});

describe('POST /book', () => {
  it('creates a multi-staff appointment + fan-out + engagement note', async () => {
    const b = await addStaff('b@test.example');
    await avail(b);
    const { queue, calls } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const res = await request(app)
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId, b],
        subject: 'Planning',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
        durationMinutes: 60,
        location: 'VIDEO',
        clientId: seed.clientId,
        engagementId: seed.engagementId,
      });
    expect(res.status).toBe(201);
    const apptId = res.body.id as string;
    const staffRows = await harness.db
      .select()
      .from(appointmentStaff)
      .where(eq(appointmentStaff.appointmentId, apptId));
    expect(staffRows).toHaveLength(2);
    expect(calls.providerWrite).toHaveLength(2);
    const notes = await harness.db
      .select()
      .from(appointmentEngagementNotes)
      .where(eq(appointmentEngagementNotes.appointmentId, apptId));
    expect(notes).toHaveLength(1);
  });

  it('409 slot_taken when a selected staff is busy', async () => {
    const b = await addStaff('b2@test.example');
    await avail(b);
    const { queue } = recorder();
    const app = buildApp({
      queue,
      busyProvider: fakeBusy({
        [b]: [{ start: new Date(`${MONDAY}T09:00:00Z`), end: new Date(`${MONDAY}T10:00:00Z`) }],
      }),
    });
    const res = await request(app)
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId, b],
        subject: 'Planning',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
        durationMinutes: 60,
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('slot_taken');
    expect(res.body.staffId).toBe(b);
  });

  it('records participants + enqueues a confirmation', async () => {
    const { contactId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Jane Client',
      email: 'jane@client.example',
    });
    const { queue, calls } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const res = await request(app)
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'Consult',
        startsAt: `${MONDAY}T11:00:00.000Z`,
        endsAt: `${MONDAY}T12:00:00.000Z`,
        durationMinutes: 60,
        clientId: seed.clientId,
        participantContactIds: [contactId],
      });
    expect(res.status).toBe(201);
    const parts = await harness.db
      .select()
      .from(appointmentParticipants)
      .where(eq(appointmentParticipants.appointmentId, res.body.id));
    expect(parts).toHaveLength(1);
    expect(calls.confirmationSend).toHaveLength(1);
  });
});

describe('reschedule + cancel', () => {
  async function book(): Promise<string> {
    const { queue } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const res = await request(app)
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'Consult',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
        durationMinutes: 60,
      });
    return res.body.id as string;
  }

  it('reschedules to a new free slot', async () => {
    const id = await book();
    const { queue, calls } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const res = await request(app)
      .post(`/api/staff/appointments/${id}/reschedule`)
      .send({ startsAt: `${MONDAY}T14:00:00.000Z`, endsAt: `${MONDAY}T15:00:00.000Z` });
    expect(res.status).toBe(200);
    const [appt] = await harness.db.select().from(appointments).where(eq(appointments.id, id));
    expect(appt!.startsAt.toISOString()).toBe(`${MONDAY}T14:00:00.000Z`);
    expect(calls.providerUpdate).toHaveLength(1);
    expect(calls.rescheduleConfirmationSend).toHaveLength(1);
  });

  it('cancels (multi-staff path) and enqueues per-staff deletes', async () => {
    const id = await book();
    const { queue, calls } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const res = await request(app)
      .post(`/api/staff/appointments/${id}/cancel`)
      .send({ reason: 'client asked' });
    expect(res.status).toBe(200);
    const [appt] = await harness.db.select().from(appointments).where(eq(appointments.id, id));
    expect(appt!.status).toBe('CANCELLED');
    expect(appt!.cancelledByActor).toBe('staff');
    expect(calls.providerDelete).toHaveLength(1);
    expect(calls.cancellationSend).toHaveLength(1);
  });
});

describe('public token flows', () => {
  async function book(): Promise<string> {
    const { queue } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const res = await request(app)
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'Consult',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
        durationMinutes: 60,
        clientId: seed.clientId,
      });
    return res.body.id as string;
  }

  it('client cancels via token → cancelled + staff notification', async () => {
    const id = await book();
    const [appt] = await harness.db.select().from(appointments).where(eq(appointments.id, id));
    const { queue, calls } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const res = await request(app)
      .post(`/api/public/appointments/${appt!.cancelToken}/cancel`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    const [after] = await harness.db.select().from(appointments).where(eq(appointments.id, id));
    expect(after!.status).toBe('CANCELLED');
    expect(after!.cancelledByActor).toBe('client');
    expect(calls.providerDelete).toHaveLength(1);
    const notifs = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.entityId, id));
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    expect(notifs[0]!.type).toBe('appointment_cancelled_by_client');
  });

  it('expired token → 410', async () => {
    const id = await book();
    await harness.db
      .update(appointments)
      .set({ tokenExpiresAt: new Date('2029-01-01T00:00:00Z') })
      .where(eq(appointments.id, id));
    const [appt] = await harness.db.select().from(appointments).where(eq(appointments.id, id));
    const { queue } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const res = await request(app)
      .post(`/api/public/appointments/${appt!.cancelToken}/cancel`)
      .send({});
    expect(res.status).toBe(410);
  });

  it('client reschedule request is idempotent + notifies booking staff', async () => {
    const id = await book();
    const [appt] = await harness.db.select().from(appointments).where(eq(appointments.id, id));
    const { queue } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    const tok = appt!.rescheduleToken!;
    const r1 = await request(app)
      .post(`/api/public/appointments/${tok}/request`)
      .send({ message: 'please move' });
    expect(r1.body.status).toBe('requested');
    const r2 = await request(app)
      .post(`/api/public/appointments/${tok}/request`)
      .send({ message: 'again' });
    expect(r2.body.status).toBe('requested');
    const reqs = await harness.db
      .select()
      .from(appointmentRescheduleRequests)
      .where(eq(appointmentRescheduleRequests.appointmentId, id));
    expect(reqs).toHaveLength(1); // idempotent
    const notifs = await harness.db
      .select()
      .from(staffNotifications)
      .where(eq(staffNotifications.entityId, id));
    expect(notifs.some((n) => n.type === 'reschedule_requested')).toBe(true);
  });

  it('staff accepts a reschedule request', async () => {
    const id = await book();
    const [appt] = await harness.db.select().from(appointments).where(eq(appointments.id, id));
    const { queue } = recorder();
    const app = buildApp({ queue, busyProvider: fakeBusy({}) });
    await request(app).post(`/api/public/appointments/${appt!.rescheduleToken}/request`).send({});
    const [reqRow] = await harness.db
      .select()
      .from(appointmentRescheduleRequests)
      .where(eq(appointmentRescheduleRequests.appointmentId, id));
    const res = await request(app)
      .post(`/api/staff/appointments/reschedule-requests/${reqRow!.id}/accept`)
      .send({ startsAt: `${MONDAY}T15:00:00.000Z`, endsAt: `${MONDAY}T16:00:00.000Z` });
    expect(res.status).toBe(200);
    const [after] = await harness.db
      .select()
      .from(appointmentRescheduleRequests)
      .where(eq(appointmentRescheduleRequests.id, reqRow!.id));
    expect(after!.status).toBe('accepted');
    const [appt2] = await harness.db.select().from(appointments).where(eq(appointments.id, id));
    expect(appt2!.startsAt.toISOString()).toBe(`${MONDAY}T15:00:00.000Z`);
  });
});
