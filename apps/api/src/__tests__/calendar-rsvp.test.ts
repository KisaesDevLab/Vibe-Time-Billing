// SPDX-License-Identifier: Elastic-2.0
//
// CAL-6 — .ics builder + the public RSVP flow (render page, record response,
// reflect into the event's attendee list, reject expired tokens).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import { calendarEvents, calendarRsvpTokens, staffCalendarConnections } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { buildIcs } from '../calendar/ics';
import { createRsvpRouter } from '../calendar/rsvp-routes';

describe('buildIcs (CAL-6)', () => {
  it('emits a valid single-event VCALENDAR', () => {
    const ics = buildIcs(
      {
        uid: 'evt-1@vibe',
        title: 'Tax review',
        start: new Date('2026-06-10T18:00:00Z'),
        end: new Date('2026-06-10T19:00:00Z'),
        location: 'Office',
      },
      new Date('2026-06-01T00:00:00Z'),
    );
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('UID:evt-1@vibe');
    expect(ics).toContain('DTSTART:20260610T180000Z');
    expect(ics).toContain('SUMMARY:Tax review');
    expect(ics).toContain('END:VCALENDAR');
  });
});

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function app(): express.Express {
  const a = express();
  a.use('/api/calendar/rsvp', createRsvpRouter({ db: harness.db }));
  return a;
}

async function makeTokenedEvent(opts: { expiresAt: Date }): Promise<{ token: string }> {
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
  const { contactId } = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Client',
    email: 'client@co.example',
  });
  const contact = { id: contactId };
  const [ev] = await harness.db
    .insert(calendarEvents)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      connectionId: conn!.id,
      providerEventId: 'evt-rsvp',
      subject: 'Planning session',
      startAt: new Date(Date.now() + 86400_000),
      endAt: new Date(Date.now() + 90000_000),
      attendees: [{ email: 'client@co.example', name: 'Client', response_status: 'none' }],
    })
    .returning({ id: calendarEvents.id });
  const [tok] = await harness.db
    .insert(calendarRsvpTokens)
    .values({ eventId: ev!.id, clientContactId: contact!.id, expiresAt: opts.expiresAt })
    .returning({ token: calendarRsvpTokens.token });
  return { token: tok!.token };
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('public RSVP (CAL-6)', () => {
  it('renders the page and records a confirm, reflecting into attendees', async () => {
    const { token } = await makeTokenedEvent({ expiresAt: new Date(Date.now() + 86400_000) });

    const get = await request(app()).get(`/api/calendar/rsvp/${token}`);
    expect(get.status).toBe(200);
    expect(get.text).toContain('Planning session');
    expect(get.text).toContain('Confirm');

    const post = await request(app())
      .post(`/api/calendar/rsvp/${token}`)
      .type('form')
      .send({ response: 'confirmed' });
    expect(post.status).toBe(200);
    expect(post.text).toContain('noted your response');

    const [tok] = await harness.db
      .select()
      .from(calendarRsvpTokens)
      .where(eq(calendarRsvpTokens.token, token));
    expect(tok!.response).toBe('confirmed');

    const [ev] = await harness.db.select().from(calendarEvents);
    const att = ev!.attendees as Array<{ email: string; response_status: string }>;
    expect(att[0]!.response_status).toBe('accepted');
  });

  it('rejects an expired token', async () => {
    const { token } = await makeTokenedEvent({ expiresAt: new Date(Date.now() - 1000) });
    const get = await request(app()).get(`/api/calendar/rsvp/${token}`);
    expect(get.status).toBe(410);
  });

  it('404s an unknown token', async () => {
    const res = await request(app()).get('/api/calendar/rsvp/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});
