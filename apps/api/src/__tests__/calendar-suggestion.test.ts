// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CAL-8 — the suggestion tick creates one pending suggestion for a just-
// ended confirmed appointment (idempotent), and the API dismisses / snoozes
// (auto-dismiss after 3) / logs it.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import {
  calendarEventMatches,
  calendarEvents,
  staffCalendarConnections,
  staffTimeSuggestionLog,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { runCalendarSuggestionTick } from '../calendar/suggestion-tick';
import { createCalendarConnectRouter } from '../calendar/connect-routes';
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

async function endedConfirmedEvent(endedMinutesAgo: number): Promise<string> {
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
  const end = new Date(Date.now() - endedMinutesAgo * 60_000);
  const [ev] = await harness.db
    .insert(calendarEvents)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      connectionId: conn!.id,
      providerEventId: 'evt-sug',
      subject: 'Advisory call',
      startAt: new Date(end.getTime() - 3600_000),
      endAt: end,
    })
    .returning({ id: calendarEvents.id });
  await harness.db.insert(calendarEventMatches).values({
    eventId: ev!.id,
    clientId: seed.clientId,
    matchTier: 'exact_email',
    matchStatus: 'confirmed',
  });
  return ev!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('time-entry suggestions (CAL-8)', () => {
  it('creates one suggestion for a just-ended event (idempotent)', async () => {
    await endedConfirmedEvent(10);
    const r1 = await runCalendarSuggestionTick(harness.db);
    expect(r1.created).toBe(1);
    const r2 = await runCalendarSuggestionTick(harness.db);
    expect(r2.created).toBe(0); // unique(event_id) guard

    const list = await request(app()).get('/api/staff/calendar/suggestions');
    expect(list.status).toBe(200);
    expect(list.body.suggestions).toHaveLength(1);
    expect(list.body.suggestions[0].clientName).toBeTruthy();
    expect(list.body.suggestions[0].durationMinutes).toBe(60);
  });

  it('does not suggest for an event that ended over 30 min ago', async () => {
    await endedConfirmedEvent(45);
    const r = await runCalendarSuggestionTick(harness.db);
    expect(r.created).toBe(0);
  });

  it('dismiss / snooze (auto-dismiss after 3) / log transitions', async () => {
    await endedConfirmedEvent(5);
    await runCalendarSuggestionTick(harness.db);
    const [sug] = await harness.db.select().from(staffTimeSuggestionLog);

    const snooze1 = await request(app()).post(`/api/staff/calendar/suggestions/${sug!.id}/snooze`);
    expect(snooze1.body.autoDismissed).toBe(false);
    await request(app()).post(`/api/staff/calendar/suggestions/${sug!.id}/snooze`);
    const snooze3 = await request(app()).post(`/api/staff/calendar/suggestions/${sug!.id}/snooze`);
    expect(snooze3.body.autoDismissed).toBe(true);
    let [row] = await harness.db
      .select()
      .from(staffTimeSuggestionLog)
      .where(eq(staffTimeSuggestionLog.id, sug!.id));
    expect(row!.action).toBe('dismissed');

    // log links a time entry id.
    const log = await request(app())
      .post(`/api/staff/calendar/suggestions/${sug!.id}/log`)
      .send({ timeEntryId: '11111111-1111-1111-1111-111111111111' });
    expect(log.status).toBe(200);
    [row] = await harness.db
      .select()
      .from(staffTimeSuggestionLog)
      .where(eq(staffTimeSuggestionLog.id, sug!.id));
    expect(row!.action).toBe('logged');
    expect(row!.timeEntryId).toBe('11111111-1111-1111-1111-111111111111');
  });
});
