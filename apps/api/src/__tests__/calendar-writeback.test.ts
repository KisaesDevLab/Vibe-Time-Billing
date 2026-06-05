// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-9 — write-back is a stub: the endpoints return 501 while
// FEATURE_CALENDAR_WRITE is off, and the service refuses to run.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createCalendarConnectRouter } from '../calendar/connect-routes';
import { CalendarWriteService, isCalendarWriteEnabled } from '../calendar/write-service';
import type { OAuthStateStore } from '../calendar/connect-shared';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const noopStore: OAuthStateStore = {
  async set() {},
  async get() {
    return null;
  },
  async del() {},
};

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
  a.use(
    '/api/staff/calendar',
    createCalendarConnectRouter({
      db: harness.db,
      stateStore: noopStore,
      redirectBase: 'https://x',
    }),
  );
  return a;
}

beforeEach(async () => {
  delete process.env['FEATURE_CALENDAR_WRITE'];
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('write-back stub (CAL-9)', () => {
  it('is disabled by default', () => {
    expect(isCalendarWriteEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCalendarWriteEnabled({ FEATURE_CALENDAR_WRITE: 'true' } as never)).toBe(true);
  });

  it('returns 501 on create/update/delete while disabled', async () => {
    const create = await request(app()).post('/api/staff/calendar/events').send({ title: 'x' });
    expect(create.status).toBe(501);
    const patch = await request(app())
      .patch('/api/staff/calendar/events/00000000-0000-0000-0000-000000000000')
      .send({});
    expect(patch.status).toBe(501);
    const del = await request(app()).delete(
      '/api/staff/calendar/events/00000000-0000-0000-0000-000000000000',
    );
    expect(del.status).toBe(501);
  });

  it('the service refuses when disabled', async () => {
    await expect(new CalendarWriteService().createEvent()).rejects.toThrow(
      'calendar_write_disabled',
    );
  });
});
