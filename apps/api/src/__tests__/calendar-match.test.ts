// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CAL-4 — matching: exact-email hit/miss, fuzzy hit/miss, multi-client
// collision, the persisted runner (idempotent on confirmed), and the
// unmatched review API (confirm / dismiss / new-client).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';

import {
  calendarEventMatches,
  calendarEvents,
  clientContacts,
  clients,
  staffCalendarConnections,
} from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { matchEvent, cleanSubject, type ClientForMatch } from '../calendar/matcher';
import { runCalendarMatch } from '../calendar/match';
import { createCalendarMatchRouter } from '../calendar/match-routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const CLIENTS: ClientForMatch[] = [
  { id: 'c-acme', name: 'Acme Industries LLC', clientFacingName: 'Acme' },
  { id: 'c-globex', name: 'Globex Corporation', clientFacingName: null },
];

describe('matcher (CAL-4, pure)', () => {
  it('cleans reply prefixes, meeting words, and dates from a subject', () => {
    expect(cleanSubject('Re: Acme tax review 6/10')).toBe('Acme tax');
    expect(cleanSubject('Globex call')).toBe('Globex');
  });

  it('exact email → confirmed single match', () => {
    const r = matchEvent(
      { subject: 'whatever', organizerEmail: 'cfo@acme.com', attendees: [] },
      CLIENTS,
      [{ clientId: 'c-acme', email: 'cfo@acme.com' }],
    );
    expect(r.tier).toBe('exact_email');
    expect(r.candidates).toEqual([{ clientId: 'c-acme', score: 1, status: 'confirmed' }]);
  });

  it('multi-client email collision → pending candidates', () => {
    const r = matchEvent(
      { subject: 'x', organizerEmail: 'a@x.com', attendees: [{ email: 'b@y.com' }] },
      CLIENTS,
      [
        { clientId: 'c-acme', email: 'a@x.com' },
        { clientId: 'c-globex', email: 'b@y.com' },
      ],
    );
    expect(r.tier).toBe('exact_email');
    expect(r.candidates.every((c) => c.status === 'pending')).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  it('fuzzy subject hit → pending fuzzy match (meeting words stripped)', () => {
    // "Acme Industries review" → cleaned to "Acme Industries" → strong hit.
    const r = matchEvent(
      { subject: 'Acme Industries review', organizerEmail: null, attendees: [] },
      CLIENTS,
      [],
    );
    expect(r.tier).toBe('fuzzy_name');
    expect(r.candidates[0]!.clientId).toBe('c-acme');
    expect(r.candidates[0]!.status).toBe('pending');
    expect(r.candidates[0]!.score).toBeGreaterThan(0.65);
  });

  it('no signal → unmatched', () => {
    const r = matchEvent(
      { subject: 'Dentist appointment', organizerEmail: 'me@self.com', attendees: [] },
      CLIENTS,
      [],
    );
    expect(r.tier).toBe('unmatched');
    expect(r.candidates[0]!.clientId).toBeNull();
  });
});

// ---- persisted runner + API -----------------------------------------

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

async function insertEvent(opts: {
  subject?: string;
  organizerEmail?: string;
  attendees?: object;
}): Promise<string> {
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
  const [ev] = await harness.db
    .insert(calendarEvents)
    .values({
      firmId: seed.firmId,
      staffId: seed.appUserId,
      connectionId: conn!.id,
      providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
      subject: opts.subject ?? null,
      organizerEmail: opts.organizerEmail ?? null,
      attendees: opts.attendees ?? [],
    })
    .returning({ id: calendarEvents.id });
  return ev!.id;
}

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
    createCalendarMatchRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
    }),
  );
  return a;
}

describe('runCalendarMatch + review API (CAL-4)', () => {
  it('auto-confirms on an exact email match and is idempotent', async () => {
    // seedMinimalFirm creates a client; add a contact email for it.
    await harness.db
      .insert(clientContacts)
      .values({ clientId: seed.clientId, fullName: 'CFO', email: 'cfo@acme.example' });
    const eventId = await insertEvent({
      subject: 'Quarterly review',
      organizerEmail: 'cfo@acme.example',
    });

    const r1 = await runCalendarMatch(harness.db, eventId);
    expect(r1.status).toBe('matched');
    const [m] = await harness.db
      .select()
      .from(calendarEventMatches)
      .where(eq(calendarEventMatches.eventId, eventId));
    expect(m!.matchStatus).toBe('confirmed');
    expect(m!.clientId).toBe(seed.clientId);

    // Re-running leaves the confirmed match alone.
    const r2 = await runCalendarMatch(harness.db, eventId);
    expect(r2.status).toBe('skipped_confirmed');
  });

  it('leaves an unknown event unmatched and lists it in the queue', async () => {
    const eventId = await insertEvent({ subject: 'Lunch with a friend' });
    await runCalendarMatch(harness.db, eventId);

    const res = await request(app()).get('/api/staff/calendar/unmatched');
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { eventId: string }) => i.eventId === eventId);
    expect(item).toBeTruthy();
    expect(item.tier).toBe('unmatched');
  });

  it('confirms a pending match to a chosen client', async () => {
    const eventId = await insertEvent({ subject: 'Mystery meeting' });
    await runCalendarMatch(harness.db, eventId);
    const [m] = await harness.db
      .select()
      .from(calendarEventMatches)
      .where(eq(calendarEventMatches.eventId, eventId));

    const res = await request(app())
      .post(`/api/staff/calendar/matches/${m!.id}/confirm`)
      .send({ clientId: seed.clientId });
    expect(res.status).toBe(200);
    const [after] = await harness.db
      .select()
      .from(calendarEventMatches)
      .where(eq(calendarEventMatches.id, m!.id));
    expect(after!.matchStatus).toBe('confirmed');
    expect(after!.clientId).toBe(seed.clientId);
    expect(after!.matchTier).toBe('manual');
  });

  it('creates a stub client from an event and links it', async () => {
    const eventId = await insertEvent({ subject: 'New Prospect Co intro' });
    await runCalendarMatch(harness.db, eventId);
    const [m] = await harness.db
      .select()
      .from(calendarEventMatches)
      .where(eq(calendarEventMatches.eventId, eventId));

    const res = await request(app()).post(`/api/staff/calendar/matches/${m!.id}/new-client`);
    expect(res.status).toBe(201);
    const newId = res.body.clientId as string;
    const [client] = await harness.db.select().from(clients).where(eq(clients.id, newId));
    expect(client!.name).toBe('New Prospect Co intro');
    const [after] = await harness.db
      .select()
      .from(calendarEventMatches)
      .where(eq(calendarEventMatches.id, m!.id));
    expect(after!.clientId).toBe(newId);
    expect(after!.matchStatus).toBe('confirmed');
  });
});
