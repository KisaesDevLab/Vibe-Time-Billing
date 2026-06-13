// SPDX-License-Identifier: Elastic-2.0
//
// BK-1 — Appointment types CRUD + per-staff booking settings/availability.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createAppointmentTypeRouter } from '../appointments/types-routes';
import { createBookingSettingsRouter } from '../appointments/booking-settings-routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

function buildApp(opts: { roles?: RoleSlug[]; appUserId?: string } = {}): express.Express {
  const app = express();
  app.use(express.json());
  const appUserId = opts.appUserId ?? seed.appUserId;
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId,
    };
    next();
  });
  const fakeUserRoles = new Map<string, RoleSlug[]>([[appUserId, opts.roles ?? ['admin']]]);
  app.use(
    '/api/staff/admin/appointment-types',
    createAppointmentTypeRouter({ db: harness.db, fakeUserRoles }),
  );
  app.use('/api/staff/booking', createBookingSettingsRouter({ db: harness.db, fakeUserRoles }));
  return app;
}

describe('appointment types CRUD', () => {
  it('creates, lists, edits, and reorders', async () => {
    const app = buildApp();
    const create = await request(app)
      .post('/api/staff/admin/appointment-types')
      .send({ name: 'Consult', defaultDurationMinutes: 60, defaultLocationType: 'IN_PERSON' });
    expect(create.status).toBe(201);
    const id = create.body.id as string;

    const create2 = await request(app)
      .post('/api/staff/admin/appointment-types')
      .send({ name: 'Review', defaultDurationMinutes: 30, defaultLocationType: 'VIDEO' });
    const id2 = create2.body.id as string;

    const list = await request(app).get('/api/staff/admin/appointment-types');
    expect(list.body.items).toHaveLength(2);

    const patch = await request(app)
      .patch(`/api/staff/admin/appointment-types/${id}`)
      .send({ isActive: false, color: '#ABCDEF' });
    expect(patch.status).toBe(200);

    const reorder = await request(app)
      .post('/api/staff/admin/appointment-types/reorder')
      .send({ order: [id2, id] });
    expect(reorder.status).toBe(200);
    const relisted = await request(app).get('/api/staff/admin/appointment-types');
    expect(relisted.body.items[0].id).toBe(id2);
  });

  it('rejects hard-delete of a type in use (409), allows when unused', async () => {
    const app = buildApp();
    const create = await request(app)
      .post('/api/staff/admin/appointment-types')
      .send({ name: 'Consult', defaultDurationMinutes: 60, defaultLocationType: 'PHONE' });
    const id = create.body.id as string;

    // Unused → 204.
    const del = await request(app).delete(`/api/staff/admin/appointment-types/${id}`);
    expect(del.status).toBe(204);

    // Recreate + attach an appointment, then delete should 409.
    const c2 = await request(app)
      .post('/api/staff/admin/appointment-types')
      .send({ name: 'Consult2', defaultDurationMinutes: 60, defaultLocationType: 'PHONE' });
    const id2 = c2.body.id as string;
    await harness.db.execute(
      sql`INSERT INTO appointment (firm_id, client_id, title, starts_at, ends_at, appointment_type_id)
          VALUES (${seed.firmId}, ${seed.clientId}, 'X', now(), now() + interval '1 hour', ${id2})`,
    );
    const del2 = await request(app).delete(`/api/staff/admin/appointment-types/${id2}`);
    expect(del2.status).toBe(409);
    expect(del2.body.error).toBe('type_in_use');
  });

  it('forbids non-admin (no firm:settings:write) from creating', async () => {
    const app = buildApp({ roles: ['staff'] });
    const create = await request(app)
      .post('/api/staff/admin/appointment-types')
      .send({ name: 'Nope', defaultDurationMinutes: 30, defaultLocationType: 'VIDEO' });
    expect(create.status).toBe(403);
  });

  it('seed-defaults inserts the CPA default set then is idempotent', async () => {
    const app = buildApp();
    const first = await request(app).post('/api/staff/admin/appointment-types/seed-defaults');
    expect(first.body.inserted).toBe(7);
    const second = await request(app).post('/api/staff/admin/appointment-types/seed-defaults');
    expect(second.body.inserted).toBe(0);
  });
});

describe('booking settings + availability', () => {
  it('returns defaults then upserts settings (self)', async () => {
    const app = buildApp({ roles: ['staff'] });
    const def = await request(app).get(`/api/staff/booking/${seed.appUserId}/settings`);
    expect(def.status).toBe(200);
    expect(def.body.settings.slotIncrementMinutes).toBe(30);

    const patch = await request(app)
      .patch(`/api/staff/booking/${seed.appUserId}/settings`)
      .send({ bufferBeforeMinutes: 15, slotIncrementMinutes: 15, bookingEnabled: false });
    expect(patch.status).toBe(200);

    const after = await request(app).get(`/api/staff/booking/${seed.appUserId}/settings`);
    expect(after.body.settings.bufferBeforeMinutes).toBe(15);
    expect(after.body.settings.slotIncrementMinutes).toBe(15);
    expect(after.body.settings.bookingEnabled).toBe(false);
  });

  it('replaces availability rows (PUT) and rejects inverted ranges', async () => {
    const app = buildApp({ roles: ['staff'] });
    const put = await request(app)
      .put(`/api/staff/booking/${seed.appUserId}/availability`)
      .send({
        rows: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
          { dayOfWeek: 2, startTime: '10:00', endTime: '15:00' },
        ],
      });
    expect(put.status).toBe(200);
    const get = await request(app).get(`/api/staff/booking/${seed.appUserId}/availability`);
    expect(get.body.rows).toHaveLength(2);

    const bad = await request(app)
      .put(`/api/staff/booking/${seed.appUserId}/availability`)
      .send({ rows: [{ dayOfWeek: 3, startTime: '17:00', endTime: '09:00' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('end_before_start');
    // The earlier two rows are untouched (txn rolled the bad PUT back before write).
    const still = await request(app).get(`/api/staff/booking/${seed.appUserId}/availability`);
    expect(still.body.rows).toHaveLength(2);
  });

  it('round-trips per-window appointment types; rejects unknown type ids', async () => {
    const app = buildApp();
    const type = await request(app)
      .post('/api/staff/admin/appointment-types')
      .send({ name: 'Tax Prep', defaultDurationMinutes: 60, defaultLocationType: 'IN_PERSON' });
    expect(type.status).toBe(201);
    const typeId = type.body.id as string;

    const put = await request(app)
      .put(`/api/staff/booking/${seed.appUserId}/availability`)
      .send({
        rows: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '12:00', appointmentTypeIds: [typeId] },
          { dayOfWeek: 1, startTime: '13:00', endTime: '17:00' },
        ],
      });
    expect(put.status).toBe(200);
    const get = await request(app).get(`/api/staff/booking/${seed.appUserId}/availability`);
    expect(get.body.rows).toHaveLength(2);
    expect(get.body.rows[0].appointmentTypeIds).toEqual([typeId]);
    expect(get.body.rows[1].appointmentTypeIds).toBeNull();

    // A type id that isn't in this firm's library is rejected.
    const bad = await request(app)
      .put(`/api/staff/booking/${seed.appUserId}/availability`)
      .send({
        rows: [
          {
            dayOfWeek: 2,
            startTime: '09:00',
            endTime: '12:00',
            appointmentTypeIds: ['00000000-0000-4000-8000-000000000000'],
          },
        ],
      });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('unknown_appointment_type');
  });

  it('forbids editing another staff member without app_user:write', async () => {
    // Second staff user in the same firm.
    const other = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'other@test.example', 'Other One', 'Other', 'One') RETURNING id`,
    );
    const otherId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const app = buildApp({ roles: ['staff'] });
    const patch = await request(app)
      .patch(`/api/staff/booking/${otherId}/settings`)
      .send({ bufferBeforeMinutes: 5 });
    expect(patch.status).toBe(403);
  });

  it('allows an admin (app_user:write) to edit another staff member', async () => {
    const other = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'other2@test.example', 'Other Two', 'Other', 'Two') RETURNING id`,
    );
    const otherId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const app = buildApp({ roles: ['admin'] });
    const patch = await request(app)
      .patch(`/api/staff/booking/${otherId}/settings`)
      .send({ bufferBeforeMinutes: 5 });
    expect(patch.status).toBe(200);
  });
});
