// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Appointments list: the named-location join on GET /list and the
// POST /list/pdf table export (rendered from the rows the client sends).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Redis } from 'ioredis';

import type { RoleSlug } from '@vibe/core/rbac';
import { appointments } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createBookingRouter } from '../appointments/booking-routes';
import { createAppointmentLocationRouter } from '../appointments/locations-routes';
import type { BookingQueue } from '../appointments/queue';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let capturedHtml = '';

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
      redis: fakeRedis as never,
      renderPdf: async (html: string) => {
        capturedHtml = html;
        return Buffer.from('%PDF-1.4 fake');
      },
    }),
  );
  a.use(
    '/api/staff/admin/appointment-locations',
    createAppointmentLocationRouter({ db: harness.db, fakeUserRoles }),
  );
  return a;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  capturedHtml = '';
});
afterEach(async () => {
  await harness.close();
});

describe('appointments list — named location on GET /list', () => {
  it('returns the location preset name (and null when none)', async () => {
    const create = await request(app())
      .post('/api/staff/admin/appointment-locations')
      .send({ name: 'Main Office', locationType: 'IN_PERSON', detail: '123 Main St' });
    const locId = create.body.id as string;

    await harness.db.insert(appointments).values([
      {
        firmId: seed.firmId,
        title: 'At the office',
        startsAt: new Date('2030-02-01T15:00:00Z'),
        endsAt: new Date('2030-02-01T16:00:00Z'),
        location: 'IN_PERSON',
        locationOptionId: locId,
      },
      {
        firmId: seed.firmId,
        title: 'A video call',
        startsAt: new Date('2030-02-02T15:00:00Z'),
        endsAt: new Date('2030-02-02T16:00:00Z'),
        location: 'VIDEO',
      },
    ]);

    const res = await request(app()).get('/api/staff/appointments/list?pageSize=1000');
    expect(res.status).toBe(200);
    const byTitle = new Map<string, { locationName: string | null }>(
      res.body.items.map((i: { title: string; locationName: string | null }) => [i.title, i]),
    );
    expect(byTitle.get('At the office')?.locationName).toBe('Main Office');
    expect(byTitle.get('A video call')?.locationName).toBeNull();
  });
});

describe('appointments list — POST /list/pdf export', () => {
  const sampleRow = {
    date: '2/1/2030',
    time: '9:00 AM',
    title: 'Quarterly review',
    staff: 'Jane Doe',
    client: 'Acme LLC',
    engagement: '2029 1040',
    location: 'Main Office',
    status: 'scheduled',
  };

  it('renders the posted rows and streams a PDF', async () => {
    const res = await request(app())
      .post('/api/staff/appointments/list/pdf')
      .send({ rows: [sampleRow], filterSummary: ['Range: This week'] });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.length).toBeGreaterThan(0);
    // The template received the row + filter summary.
    expect(capturedHtml).toContain('Quarterly review');
    expect(capturedHtml).toContain('Main Office');
    expect(capturedHtml).toContain('Range: This week');
  });

  it('rejects a malformed payload with 400', async () => {
    const res = await request(app())
      .post('/api/staff/appointments/list/pdf')
      .send({ rows: 'not-an-array' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('requires appointment:read (403 without it)', async () => {
    const res = await request(app([]))
      .post('/api/staff/appointments/list/pdf')
      .send({ rows: [sampleRow] });
    expect(res.status).toBe(403);
  });
});
