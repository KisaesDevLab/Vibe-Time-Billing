// SPDX-License-Identifier: Elastic-2.0
//
// CAL-5 — the dashboard data path: GET /events/my resolves each event's
// confirmed-match client name; GET /unmatched/count badges pending events.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { calendarEventMatches, calendarEvents, staffCalendarConnections } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createCalendarConnectRouter } from '../calendar/connect-routes';
import { createCalendarMatchRouter } from '../calendar/match-routes';
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
  a.use(
    '/api/staff/calendar',
    createCalendarMatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    }),
  );
  return a;
}

let connId = '';
async function ensureConn(): Promise<string> {
  if (connId) return connId;
  const [conn] = await harness.db
    .insert(staffCalendarConnections)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      provider: 'google',
      tDekWrapped: Buffer.from([1]),
      accessTokenEnc: Buffer.from([1]),
    })
    .returning({ id: staffCalendarConnections.id });
  connId = conn!.id;
  return connId;
}

async function makeEvent(startAt: Date): Promise<string> {
  const connectionId = await ensureConn();
  const [ev] = await harness.db
    .insert(calendarEvents)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      connectionId,
      providerEventId: `e-${Math.random().toString(36).slice(2)}`,
      subject: 'Client meeting',
      startAt,
      endAt: new Date(startAt.getTime() + 3600_000),
    })
    .returning({ id: calendarEvents.id });
  return ev!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  connId = '';
});
afterEach(async () => {
  await harness.close();
});

describe('calendar dashboard endpoints (CAL-5)', () => {
  it('/events/my resolves the confirmed client name and respects the window', async () => {
    // Midday today — always inside the [startOfDay, +24h) "today" window
    // regardless of the wall clock (now+2h would roll into tomorrow when
    // the suite runs late in the day, a pre-existing time-of-day flake).
    const now = new Date();
    const middayToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const eventId = await makeEvent(middayToday);
    await harness.db.insert(calendarEventMatches).values({
      eventId,
      clientId: seed.clientId,
      matchTier: 'exact_email',
      matchScore: 1,
      matchStatus: 'confirmed',
    });

    const today = await request(app()).get('/api/staff/calendar/events/my?view=today');
    expect(today.status).toBe(200);
    const ev = today.body.events.find((e: { id: string }) => e.id === eventId);
    expect(ev.matchStatus).toBe('confirmed');
    expect(ev.clientId).toBe(seed.clientId);
    expect(ev.clientName).toBeTruthy();

    // An event 3 days out is in the week view but not today.
    const far = await makeEvent(new Date(Date.now() + 3 * 86400_000));
    const week = await request(app()).get('/api/staff/calendar/events/my?view=week');
    expect(week.body.events.some((e: { id: string }) => e.id === far)).toBe(true);
    const today2 = await request(app()).get('/api/staff/calendar/events/my?view=today');
    expect(today2.body.events.some((e: { id: string }) => e.id === far)).toBe(false);
  });

  it('/unmatched/count counts pending events for the staff member', async () => {
    const eventId = await makeEvent(new Date(Date.now() + 3600_000));
    await harness.db.insert(calendarEventMatches).values({
      eventId,
      clientId: null,
      matchTier: 'unmatched',
      matchStatus: 'pending',
    });
    const res = await request(app()).get('/api/staff/calendar/unmatched/count');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});
