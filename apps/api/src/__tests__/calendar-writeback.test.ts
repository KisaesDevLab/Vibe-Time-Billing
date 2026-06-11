// SPDX-License-Identifier: Elastic-2.0
//
// CAL-9 — calendar write-back. While FEATURE_CALENDAR_WRITE is off the
// endpoints return 501 and the service refuses to run. When on, TB pushes
// events to a write-scoped connected calendar, mirrors them with
// tb_origin=true, and propagates appointment create/cancel.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appointments,
  calendarEvents,
  calendarProviderConfig,
  calendarRsvpTokens,
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
import { createCalendarConnectRouter } from '../calendar/connect-routes';
import { createRsvpRouter } from '../calendar/rsvp-routes';
import { createAppointmentRouter } from '../appointments/routes';
import { CalendarWriteService, isCalendarWriteEnabled } from '../calendar/write-service';
import type { OAuthStateStore } from '../calendar/connect-shared';

const GOOGLE_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GOOGLE_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let sealDir: string;

const noopStore: OAuthStateStore = {
  async set() {},
  async get() {
    return null;
  },
  async del() {},
};

// Records the calls the writers make, and returns provider responses.
let providerCalls: Array<{ method: string; url: string; body: unknown }>;
let createSeq = 0;
const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  providerCalls.push({ method, url: u, body });
  if (u.includes('/calendar/v3/calendars/') && u.includes('/events')) {
    if (method === 'POST') {
      createSeq += 1;
      return new Response(
        JSON.stringify({
          id: `g-${createSeq}`,
          htmlLink: `https://cal/g-${createSeq}`,
          etag: '"e1"',
        }),
        { status: 200 },
      );
    }
    if (method === 'PATCH') {
      return new Response(
        JSON.stringify({ id: 'g-1', htmlLink: 'https://cal/g-1', etag: '"e2"' }),
        {
          status: 200,
        },
      );
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
  }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

async function seedConnection(scope: string): Promise<string> {
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
      staffId: seed.appUserId,
      provider: 'google',
      tDekWrapped: Buffer.from(ck.wrappedDek),
      accessTokenEnc: encField(ck.dek, 'acc')!,
      refreshTokenEnc: encField(ck.dek, 'ref'),
      tokenExpiry: new Date(Date.now() + 3600_000),
      scope,
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
  return conn!.id;
}

function calendarApp(): express.Express {
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
      fetchImpl: mockFetch,
    }),
  );
  return a;
}

function appointmentApp(): express.Express {
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
    '/api/staff/appointments',
    createAppointmentRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
      fetchImpl: mockFetch,
    }),
  );
  return a;
}

function rsvpApp(): express.Express {
  const a = express();
  a.use('/api/calendar/rsvp', createRsvpRouter({ db: harness.db, fetchImpl: mockFetch }));
  return a;
}

/** Seed an ingested (non-tb_origin) event + contact + RSVP token. */
async function seedRsvp(connectionId: string): Promise<string> {
  const { contactId } = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Jane Client',
    email: 'jane@client.example',
  });
  const contact = { id: contactId };
  const [ev] = await harness.db
    .insert(calendarEvents)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      connectionId,
      providerEventId: 'g-ingested-1',
      calendarId: 'primary',
      subject: 'Review',
      startAt: new Date('2027-04-15T15:00:00Z'),
      endAt: new Date('2027-04-15T15:30:00Z'),
      attendees: [{ email: 'jane@client.example', name: 'Jane', response_status: null }],
    })
    .returning({ id: calendarEvents.id });
  const [tok] = await harness.db
    .insert(calendarRsvpTokens)
    .values({ eventId: ev!.id, clientContactId: contact!.id })
    .returning({ token: calendarRsvpTokens.token });
  return tok!.token;
}

beforeEach(async () => {
  sealDir = await mkdtemp(join(tmpdir(), 'vibe-cal-wb-'));
  process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await getFirmKeyManager(harness.db).bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
  providerCalls = [];
  createSeq = 0;
});
afterEach(async () => {
  delete process.env['FEATURE_CALENDAR_WRITE'];
  resetFirmKeyManagerForTests();
  await harness.close();
  await rm(sealDir, { recursive: true, force: true });
});

describe('write-back disabled (CAL-9)', () => {
  beforeEach(() => {
    delete process.env['FEATURE_CALENDAR_WRITE'];
  });

  it('flag helper reflects the env var', () => {
    expect(isCalendarWriteEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCalendarWriteEnabled({ FEATURE_CALENDAR_WRITE: 'true' } as never)).toBe(true);
  });

  it('returns 501 on create/update/delete while disabled', async () => {
    const create = await request(calendarApp())
      .post('/api/staff/calendar/events')
      .send({ title: 'x' });
    expect(create.status).toBe(501);
    const patch = await request(calendarApp())
      .patch('/api/staff/calendar/events/00000000-0000-0000-0000-000000000000')
      .send({ title: 'y' });
    expect(patch.status).toBe(501);
    const del = await request(calendarApp()).delete(
      '/api/staff/calendar/events/00000000-0000-0000-0000-000000000000',
    );
    expect(del.status).toBe(501);
  });

  it('the service refuses when disabled', async () => {
    await expect(
      new CalendarWriteService().createEvent(
        { db: harness.db },
        {
          firmId: seed.firmId,
          staffId: seed.appUserId,
          connectionId: '00000000-0000-0000-0000-000000000000',
          calendarId: 'primary',
          input: { title: 'x', start: new Date(), end: new Date(Date.now() + 1000) },
        },
      ),
    ).rejects.toThrow('calendar_write_disabled');
  });
});

describe('write-back enabled (CAL-9)', () => {
  beforeEach(() => {
    process.env['FEATURE_CALENDAR_WRITE'] = 'true';
  });

  it('creates, updates and deletes a TB-origin event on the provider', async () => {
    const connectionId = await seedConnection(GOOGLE_WRITE_SCOPE);

    const create = await request(calendarApp()).post('/api/staff/calendar/events').send({
      connectionId,
      calendarId: 'primary',
      title: 'Client review',
      start: '2027-04-15T15:00:00.000Z',
      end: '2027-04-15T15:30:00.000Z',
      location: 'Zoom',
    });
    expect(create.status).toBe(201);
    expect(create.body.providerEventId).toBe('g-1');
    const eventId = create.body.eventId as string;

    const [row] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, eventId));
    expect(row!.tbOrigin).toBe(true);
    expect(row!.providerEventId).toBe('g-1');
    expect(row!.subject).toBe('Client review');
    expect(providerCalls.some((c) => c.method === 'POST')).toBe(true);

    const patch = await request(calendarApp())
      .patch(`/api/staff/calendar/events/${eventId}`)
      .send({ title: 'Client review (updated)' });
    expect(patch.status).toBe(200);
    const [updated] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, eventId));
    expect(updated!.subject).toBe('Client review (updated)');
    expect(providerCalls.some((c) => c.method === 'PATCH')).toBe(true);

    const del = await request(calendarApp()).delete(`/api/staff/calendar/events/${eventId}`);
    expect(del.status).toBe(200);
    const [deleted] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, eventId));
    expect(deleted!.softDeletedAt).not.toBeNull();
    expect(providerCalls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('rejects create when the connection lacks the write scope (409)', async () => {
    const connectionId = await seedConnection(GOOGLE_READ_SCOPE);
    const res = await request(calendarApp()).post('/api/staff/calendar/events').send({
      connectionId,
      calendarId: 'primary',
      title: 'No scope',
      start: '2027-04-15T15:00:00.000Z',
      end: '2027-04-15T15:30:00.000Z',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('write_scope_missing');
    expect(providerCalls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects an unknown / non-owned event id (404)', async () => {
    await seedConnection(GOOGLE_WRITE_SCOPE);
    const res = await request(calendarApp()).delete(
      '/api/staff/calendar/events/00000000-0000-0000-0000-000000000000',
    );
    expect(res.status).toBe(404);
  });

  it('mirrors an appointment onto the lead calendar and removes it on cancel', async () => {
    await seedConnection(GOOGLE_WRITE_SCOPE);

    const create = await request(appointmentApp()).post('/api/staff/appointments').send({
      clientId: seed.clientId,
      title: 'Tax-prep call',
      startsAt: '2027-04-15T15:00:00.000Z',
      endsAt: '2027-04-15T15:30:00.000Z',
      location: 'VIDEO',
      locationDetail: 'https://meet/abc',
    });
    expect(create.status).toBe(201);
    expect(create.body.calendarPushed).toBe(true);
    const apptId = create.body.id as string;

    const [appt] = await harness.db.select().from(appointments).where(eq(appointments.id, apptId));
    expect(appt!.externalRef).toBeTruthy();

    // A tb_origin mirror exists.
    const [mirror] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, appt!.externalRef!));
    expect(mirror!.tbOrigin).toBe(true);
    expect(mirror!.subject).toBe('Tax-prep call');

    // Cancel removes it from the provider and soft-deletes the mirror.
    const cancel = await request(appointmentApp())
      .post(`/api/staff/appointments/${apptId}/cancel`)
      .send({ reason: 'client rescheduled' });
    expect(cancel.status).toBe(200);
    const [afterCancel] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.id, appt!.externalRef!));
    expect(afterCancel!.softDeletedAt).not.toBeNull();
    expect(providerCalls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('pushes the RSVP response to the provider event (attendee write-back)', async () => {
    const connectionId = await seedConnection(GOOGLE_WRITE_SCOPE);
    const token = await seedRsvp(connectionId);

    const res = await request(rsvpApp())
      .post(`/api/calendar/rsvp/${token}`)
      .send({ response: 'confirmed' });
    expect(res.status).toBe(200);

    // Local attendee response updated...
    const [updated] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.providerEventId, 'g-ingested-1'));
    const att = updated!.attendees as Array<{ email: string; response_status: string }>;
    expect(att[0]!.response_status).toBe('accepted');

    // ...and pushed to the provider as a PATCH carrying the response.
    const patch = providerCalls.find((c) => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(JSON.stringify(patch!.body)).toContain('accepted');
  });

  it('does not push RSVP to the provider when the connection is read-only', async () => {
    const connectionId = await seedConnection(GOOGLE_READ_SCOPE);
    const token = await seedRsvp(connectionId);
    const res = await request(rsvpApp())
      .post(`/api/calendar/rsvp/${token}`)
      .send({ response: 'declined' });
    expect(res.status).toBe(200);
    // Local update still happens; no provider PATCH attempted.
    const [updated] = await harness.db
      .select()
      .from(calendarEvents)
      .where(eq(calendarEvents.providerEventId, 'g-ingested-1'));
    const att = updated!.attendees as Array<{ response_status: string }>;
    expect(att[0]!.response_status).toBe('declined');
    expect(providerCalls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('does not push when the lead has no write-capable connection', async () => {
    // Connection exists but only read scope → resolveTarget returns null.
    await seedConnection(GOOGLE_READ_SCOPE);
    const create = await request(appointmentApp()).post('/api/staff/appointments').send({
      clientId: seed.clientId,
      title: 'No push',
      startsAt: '2027-04-15T15:00:00.000Z',
      endsAt: '2027-04-15T15:30:00.000Z',
    });
    expect(create.status).toBe(201);
    expect(create.body.calendarPushed).toBe(false);
  });
});
