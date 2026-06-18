// SPDX-License-Identifier: Elastic-2.0
//
// 0168 — public self-booking router: resolve a slug, list page-availability
// slots, submit a request (creates a PENDING hold, NOT an appointment), and
// confirm the held slot disappears from availability.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';

import {
  appointments,
  bookingRequests,
  offices,
  publicBookingAvailability,
  staffPublicBookingLinks,
} from '@vibe/db/schema';

import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPublicBookingRouter } from '../appointments/public-booking-routes';
import { createBookingAdminRouter } from '../appointments/booking-admin-routes';
import { resetFirmKeyManagerForTests } from '../crypto/manager';
import type { StaffBusyProvider } from '../appointments/availability';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let redis: Redis;
let sealDir: string;

const MONDAY = '2030-01-07';
const NOW = new Date(`${MONDAY}T00:00:00Z`);
const emptyBusy: StaffBusyProvider = {
  async getBusy() {
    return [];
  },
};

function dow(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/public/book',
    createPublicBookingRouter({
      db: harness.db,
      redis,
      busyProvider: emptyBusy,
      now: () => NOW,
      sendEmail: async () => undefined,
      sendSms: async () => undefined,
    }),
  );
  return app;
}

async function makeLink(slug: string): Promise<string> {
  const [link] = await harness.db
    .insert(staffPublicBookingLinks)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      slug,
      requireCaptcha: false,
      minNoticeHours: 0,
      slotIncrementMinutes: 60,
      defaultDurationMinutes: 60,
    })
    .returning({ id: staffPublicBookingLinks.id });
  await harness.db.insert(publicBookingAvailability).values({
    bookingLinkId: link!.id,
    dayOfWeek: dow(MONDAY),
    startTime: '09:00',
    endTime: '12:00',
    isActive: true,
  });
  return link!.id;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-pubbook-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  // Pin the firm timezone to UTC so the slot assertions are zone-independent.
  await harness.db.update(offices).set({ timezone: 'UTC' }).where(eq(offices.firmId, seed.firmId));
});
afterEach(async () => {
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('public booking router', () => {
  it('resolves an active slug', async () => {
    await makeLink('kurt-consult');
    const res = await request(buildApp()).get('/api/public/book/kurt-consult');
    expect(res.status).toBe(200);
    expect(res.body.staffName).toBeTruthy();
    expect(Array.isArray(res.body.types)).toBe(true);
  });

  it('404s an unknown or inactive slug', async () => {
    const res = await request(buildApp()).get('/api/public/book/nope');
    expect(res.status).toBe(404);
  });

  it('lists page-availability slots', async () => {
    await makeLink('slots-page');
    const res = await request(buildApp()).get(`/api/public/book/slots-page/slots?date=${MONDAY}`);
    expect(res.status).toBe(200);
    expect(res.body.slots.map((s: { start: string }) => s.start)).toEqual([
      `${MONDAY}T09:00:00.000Z`,
      `${MONDAY}T10:00:00.000Z`,
      `${MONDAY}T11:00:00.000Z`,
    ]);
  });

  it('submit creates a PENDING request (no appointment) and holds the slot', async () => {
    const linkId = await makeLink('book-me');
    const app = buildApp();
    const start = `${MONDAY}T09:00:00.000Z`;
    const res = await request(app)
      .post('/api/public/book/book-me/request')
      .send({ name: 'Jane Visitor', email: 'jane@example.com', startsAt: start });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    // A PENDING booking_request exists; NO appointment was created.
    const reqs = await harness.db
      .select()
      .from(bookingRequests)
      .where(eq(bookingRequests.bookingLinkId, linkId));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.status).toBe('PENDING');
    const appts = await harness.db
      .select()
      .from(appointments)
      .where(eq(appointments.firmId, seed.firmId));
    expect(appts).toHaveLength(0);

    // The held 09:00 slot is no longer offered.
    const after = await request(app).get(`/api/public/book/book-me/slots?date=${MONDAY}`);
    expect(after.body.slots.map((s: { start: string }) => s.start)).toEqual([
      `${MONDAY}T10:00:00.000Z`,
      `${MONDAY}T11:00:00.000Z`,
    ]);
  });

  it('rejects a slot that is not offered', async () => {
    await makeLink('bad-slot');
    const res = await request(buildApp())
      .post('/api/public/book/bad-slot/request')
      .send({ name: 'X', email: 'x@example.com', startsAt: `${MONDAY}T15:00:00.000Z` });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('slot_taken');
  });
});

function buildAdminApp(roles: RoleSlug[] = ['admin']): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  const fakeUserRoles = new Map<string, RoleSlug[]>([[seed.appUserId, roles]]);
  app.use(
    '/api/staff/appointments',
    createBookingAdminRouter({
      db: harness.db,
      fakeUserRoles,
      sendEmail: async () => undefined,
      staffBaseUrl: 'https://app.example',
    }),
  );
  return app;
}

async function insertPendingRequest(linkId: string | null): Promise<string> {
  const [row] = await harness.db
    .insert(bookingRequests)
    .values({
      firmId: seed.firmId,
      bookingLinkId: linkId,
      staffId: seed.appUserId,
      startsAt: new Date(`${MONDAY}T09:00:00Z`),
      endsAt: new Date(`${MONDAY}T10:00:00Z`),
      durationMinutes: 60,
      visitorName: 'Pat Visitor',
      visitorEmail: 'pat@example.com',
      status: 'PENDING',
      holdExpiresAt: new Date('2030-02-01T00:00:00Z'),
    })
    .returning({ id: bookingRequests.id });
  return row!.id;
}

describe('booking admin router', () => {
  it('creates a booking page with windows + an auto slug', async () => {
    const res = await request(buildAdminApp())
      .post('/api/staff/appointments/booking-links')
      .send({
        staffId: seed.appUserId,
        windows: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }],
        approverIds: [seed.appUserId],
      });
    expect(res.status).toBe(201);
    expect(res.body.slug).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{7}$/);
    const detail = await request(buildAdminApp()).get(
      `/api/staff/appointments/booking-links/${res.body.id}`,
    );
    expect(detail.body.windows).toHaveLength(1);
    expect(detail.body.approverIds).toEqual([seed.appUserId]);
  });

  it('editing a page keeping its own custom slug does not 409 (slug self-clash fix)', async () => {
    const created = await request(buildAdminApp())
      .post('/api/staff/appointments/booking-links')
      .send({ staffId: seed.appUserId, slug: 'kurt-consult' });
    expect(created.status).toBe(201);
    const patch = await request(buildAdminApp())
      .patch(`/api/staff/appointments/booking-links/${created.body.id}`)
      .send({ slug: 'kurt-consult', customMessage: 'Updated' });
    expect(patch.status).toBe(200);
    // A DIFFERENT page's slug is still rejected.
    const other = await request(buildAdminApp())
      .post('/api/staff/appointments/booking-links')
      .send({ staffId: seed.appUserId, slug: 'other-page' });
    const clash = await request(buildAdminApp())
      .patch(`/api/staff/appointments/booking-links/${created.body.id}`)
      .send({ slug: 'other-page' });
    expect(other.status).toBe(201);
    expect(clash.status).toBe(409);
  });

  it('approve creates the appointment and marks the request APPROVED', async () => {
    const reqId = await insertPendingRequest(null);
    const res = await request(buildAdminApp()).post(
      `/api/staff/appointments/booking-requests/${reqId}/approve`,
    );
    expect(res.status).toBe(200);
    expect(res.body.appointmentId).toBeTruthy();
    const [reqRow] = await harness.db
      .select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, reqId));
    expect(reqRow!.status).toBe('APPROVED');
    expect(reqRow!.createdAppointmentId).toBe(res.body.appointmentId);
    const appts = await harness.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, res.body.appointmentId));
    expect(appts).toHaveLength(1);
    expect(appts[0]!.status).toBe('SCHEDULED');
  });

  it('decline marks the request DECLINED (no appointment)', async () => {
    const reqId = await insertPendingRequest(null);
    const res = await request(buildAdminApp())
      .post(`/api/staff/appointments/booking-requests/${reqId}/decline`)
      .send({ reason: 'Out that day' });
    expect(res.status).toBe(200);
    const [reqRow] = await harness.db
      .select()
      .from(bookingRequests)
      .where(eq(bookingRequests.id, reqId));
    expect(reqRow!.status).toBe('DECLINED');
    const appts = await harness.db
      .select()
      .from(appointments)
      .where(eq(appointments.firmId, seed.firmId));
    expect(appts).toHaveLength(0);
  });

  it('a non-approver cannot decide a request', async () => {
    // A second real staff member is the page's only approver + the request's
    // staff; the acting seed user is neither → 403.
    const { sql } = await import('drizzle-orm');
    const r = await harness.db.execute(
      sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
          VALUES (${seed.firmId}, 'other@test.example', 'Other', 'O', 'T') RETURNING id`,
    );
    const otherId = (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const created = await request(buildAdminApp())
      .post('/api/staff/appointments/booking-links')
      .send({ staffId: otherId, approverIds: [otherId] });
    const [reqRow] = await harness.db
      .insert(bookingRequests)
      .values({
        firmId: seed.firmId,
        bookingLinkId: created.body.id,
        staffId: otherId,
        startsAt: new Date(`${MONDAY}T09:00:00Z`),
        endsAt: new Date(`${MONDAY}T10:00:00Z`),
        durationMinutes: 60,
        visitorName: 'Pat',
        visitorEmail: 'pat@example.com',
        status: 'PENDING',
        holdExpiresAt: new Date('2030-02-01T00:00:00Z'),
      })
      .returning({ id: bookingRequests.id });
    const res = await request(buildAdminApp()).post(
      `/api/staff/appointments/booking-requests/${reqRow!.id}/approve`,
    );
    expect(res.status).toBe(403);
  });
});
