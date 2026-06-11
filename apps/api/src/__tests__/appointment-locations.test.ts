// SPDX-License-Identifier: Elastic-2.0
//
// 0144 — appointment location presets: admin CRUD, booking with a chosen
// preset (fills type + detail), availability window location persistence,
// and the window-location prefill at booking time.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { RoleSlug } from '@vibe/core/rbac';
import { appointments, staffAvailability } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createBookingRouter } from '../appointments/booking-routes';
import { createAppointmentLocationRouter } from '../appointments/locations-routes';
import { createBookingSettingsRouter } from '../appointments/booking-settings-routes';
import type { StaffBusyProvider } from '../appointments/availability';
import type { BookingQueue } from '../appointments/queue';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const MONDAY = '2030-01-07';
const NOW = (): Date => new Date('2030-01-01T00:00:00Z');

const noopQueue: BookingQueue = {
  async providerWrite() {},
  async providerUpdate() {},
  async providerDelete() {},
  async confirmationSend() {},
  async rescheduleConfirmationSend() {},
  async cancellationSend() {},
  async declineSend() {},
  async rescheduleRequestedStaffSend() {},
};

const noBusy: StaffBusyProvider = {
  async getBusy() {
    return [];
  },
};

const fakeRedis = new Proxy(
  {},
  {
    get: () => async () => {
      throw new Error('no-redis');
    },
  },
) as unknown as Redis;

function app(roles: RoleSlug[] = ['admin']): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const fakeUserRoles = new Map<string, RoleSlug[]>([[seed.appUserId, roles]]);
  a.use(
    '/api/staff/appointments',
    createBookingRouter({
      db: harness.db,
      fakeUserRoles,
      queue: noopQueue,
      busyProvider: noBusy,
      redis: fakeRedis as never,
      now: NOW,
    }),
  );
  a.use(
    '/api/staff/admin/appointment-locations',
    createAppointmentLocationRouter({ db: harness.db, fakeUserRoles }),
  );
  a.use('/api/staff/booking', createBookingSettingsRouter({ db: harness.db, fakeUserRoles }));
  return a;
}

async function createLocation(body: Record<string, unknown>): Promise<string> {
  const res = await request(app()).post('/api/staff/admin/appointment-locations').send(body);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function seedAvailability(locationId: string | null): Promise<void> {
  await harness.db.insert(staffAvailability).values({
    staffId: seed.appUserId,
    dayOfWeek: 1, // Monday
    startTime: '09:00',
    endTime: '17:00',
    isActive: true,
    ...(locationId ? { locationOptionId: locationId } : {}),
  });
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await harness.db.execute(sql`UPDATE office SET timezone = 'UTC' WHERE firm_id = ${seed.firmId}`);
});
afterEach(async () => {
  await harness.close();
});

describe('appointment location presets — admin CRUD (0144)', () => {
  it('creates, lists, edits, and refuses to delete one in use', async () => {
    const id = await createLocation({
      name: 'Main Office',
      locationType: 'IN_PERSON',
      detail: '123 Main St',
    });

    const list = await request(app()).get('/api/staff/admin/appointment-locations');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].name).toBe('Main Office');

    const patch = await request(app())
      .patch(`/api/staff/admin/appointment-locations/${id}`)
      .send({ detail: '123 Main St, Suite 200' });
    expect(patch.status).toBe(200);

    // Use it on an appointment, then deletion must 409.
    await harness.db.insert(appointments).values({
      firmId: seed.firmId,
      title: 'X',
      startsAt: new Date(`${MONDAY}T09:00:00Z`),
      endsAt: new Date(`${MONDAY}T10:00:00Z`),
      location: 'IN_PERSON',
      locationOptionId: id,
    });
    const del = await request(app()).delete(`/api/staff/admin/appointment-locations/${id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('location_in_use');
  });

  it('requires firm:settings:write to create', async () => {
    const res = await request(app(['staff']))
      .post('/api/staff/admin/appointment-locations')
      .send({ name: 'X', locationType: 'PHONE' });
    expect(res.status).toBe(403);
  });
});

describe('booking with a location preset (0144)', () => {
  it('fills the appointment location type + detail from the chosen preset', async () => {
    const id = await createLocation({
      name: 'Zoom Room',
      locationType: 'VIDEO',
      detail: 'https://zoom.us/j/123',
    });
    await seedAvailability(null);

    const res = await request(app())
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'Consult',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
        appointmentLocationId: id,
      });
    expect(res.status).toBe(201);
    const [appt] = await harness.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, res.body.id));
    expect(appt!.location).toBe('VIDEO');
    expect(appt!.locationDetail).toBe('https://zoom.us/j/123');
    expect(appt!.locationOptionId).toBe(id);
  });

  it('400s on an unknown / foreign location id', async () => {
    await seedAvailability(null);
    const res = await request(app())
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'Consult',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
        appointmentLocationId: '00000000-0000-0000-0000-000000000000',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_location');
  });
});

describe('availability window location (0144)', () => {
  it('persists and returns a window location, and prefills it at booking', async () => {
    const id = await createLocation({
      name: 'Downtown',
      locationType: 'IN_PERSON',
      detail: '55 LaSalle',
    });

    // Save a Monday window tagged with the location via the availability API.
    const put = await request(app())
      .put(`/api/staff/booking/${seed.appUserId}/availability`)
      .send({
        rows: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', locationId: id, isActive: true },
        ],
      });
    expect(put.status).toBe(200);

    const get = await request(app()).get(`/api/staff/booking/${seed.appUserId}/availability`);
    expect(get.body.rows[0].locationOptionId).toBe(id);

    // Book a slot in that window WITHOUT specifying any location → inherits it.
    const res = await request(app())
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'Drop-in',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
      });
    expect(res.status).toBe(201);
    const [appt] = await harness.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, res.body.id));
    expect(appt!.locationOptionId).toBe(id);
    expect(appt!.location).toBe('IN_PERSON');
    expect(appt!.locationDetail).toBe('55 LaSalle');
  });

  it('an explicit booking location still wins over the window default', async () => {
    const id = await createLocation({
      name: 'Downtown',
      locationType: 'IN_PERSON',
      detail: '55 LaSalle',
    });
    await request(app())
      .put(`/api/staff/booking/${seed.appUserId}/availability`)
      .send({
        rows: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00', locationId: id, isActive: true },
        ],
      });
    const res = await request(app())
      .post('/api/staff/appointments/book')
      .send({
        staffIds: [seed.appUserId],
        subject: 'Phone call',
        startsAt: `${MONDAY}T09:00:00.000Z`,
        endsAt: `${MONDAY}T10:00:00.000Z`,
        location: 'PHONE',
        locationDetail: '(312) 555-0148',
      });
    expect(res.status).toBe(201);
    const [appt] = await harness.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, res.body.id));
    expect(appt!.location).toBe('PHONE');
    expect(appt!.locationDetail).toBe('(312) 555-0148');
    expect(appt!.locationOptionId).toBeNull();
  });
});
