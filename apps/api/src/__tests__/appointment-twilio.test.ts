// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0121 — two-way appointment confirmation webhooks (Twilio). Signature
// verification + RSVP flip on inbound SMS "YES" / voice press-1.

import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { appointmentParticipants, appointments } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createAppointmentTwilioRouter } from '../appointments/twilio-routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const TOKEN = 'test-auth-token';
const BASE = 'https://test.example';
const MOUNT = '/api/public/appointments/twilio';

const fakeRedis = new Proxy(
  {},
  {
    get() {
      return async () => {
        throw new Error('no-redis'); // rate-limiter fails open
      };
    },
  },
) as unknown as Redis;

function app(): express.Express {
  const a = express();
  a.use(
    MOUNT,
    createAppointmentTwilioRouter({
      db: harness.db,
      redis: fakeRedis,
      baseUrl: BASE,
      authTokens: [TOKEN],
    }),
  );
  return a;
}

/** Compute a valid Twilio signature for the given full URL + POST params. */
function sign(fullUrl: string, params: Record<string, string>): string {
  let data = fullUrl;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac('sha1', TOKEN).update(data, 'utf8').digest('base64');
}

async function seedApptWithContact(phone: string): Promise<{ apptId: string; contactId: string }> {
  const [appt] = await harness.db
    .insert(appointments)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      title: 'Confirm me',
      startsAt: new Date(Date.now() + 2 * 24 * 3600 * 1000),
      endsAt: new Date(Date.now() + 2 * 24 * 3600 * 1000 + 30 * 60000),
      durationMinutes: 30,
      location: 'VIDEO',
      status: 'SCHEDULED',
      leadAppUserId: seed.appUserId,
      createdById: seed.appUserId,
      cancelToken: sql`gen_random_uuid()` as never,
      rescheduleToken: sql`gen_random_uuid()` as never,
    })
    .returning({ id: appointments.id });
  const c = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Confirm Contact',
    email: 'c@client.example',
    mobile: phone,
  });
  await harness.db
    .insert(appointmentParticipants)
    .values({ appointmentId: appt!.id, clientContactId: c.contactId });
  return { apptId: appt!.id, contactId: c.contactId };
}

async function rsvp(apptId: string): Promise<string> {
  const [p] = await harness.db
    .select({ s: appointmentParticipants.rsvpStatus })
    .from(appointmentParticipants)
    .where(eq(appointmentParticipants.appointmentId, apptId));
  return p!.s;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('twilio inbound SMS confirm', () => {
  it('flips RSVP to confirmed on a valid-signature "YES"', async () => {
    const { apptId } = await seedApptWithContact('+15551230001');
    const params = { From: '+15551230001', Body: 'YES' };
    const res = await request(app())
      .post(`${MOUNT}/sms`)
      .set('X-Twilio-Signature', sign(`${BASE}${MOUNT}/sms`, params))
      .type('form')
      .send(params);
    expect(res.status).toBe(200);
    expect(res.text).toContain('confirmed');
    expect(await rsvp(apptId)).toBe('confirmed');
  });

  it('rejects a bad signature with 403', async () => {
    const { apptId } = await seedApptWithContact('+15551230002');
    const res = await request(app())
      .post(`${MOUNT}/sms`)
      .set('X-Twilio-Signature', 'wrong')
      .type('form')
      .send({ From: '+15551230002', Body: 'YES' });
    expect(res.status).toBe(403);
    expect(await rsvp(apptId)).toBe('pending');
  });

  it('a non-keyword text is a 200 no-op', async () => {
    const { apptId } = await seedApptWithContact('+15551230003');
    const params = { From: '+15551230003', Body: 'what time again?' };
    const res = await request(app())
      .post(`${MOUNT}/sms`)
      .set('X-Twilio-Signature', sign(`${BASE}${MOUNT}/sms`, params))
      .type('form')
      .send(params);
    expect(res.status).toBe(200);
    expect(await rsvp(apptId)).toBe('pending');
  });
});

describe('twilio voice press-1 confirm', () => {
  it('flips RSVP on Digits=1 with a valid signature', async () => {
    const { apptId, contactId } = await seedApptWithContact('+15551230004');
    const path = `${MOUNT}/voice-gather?a=${apptId}&c=${contactId}`;
    const params = { Digits: '1' };
    const res = await request(app())
      .post(path)
      .set('X-Twilio-Signature', sign(`${BASE}${path}`, params))
      .type('form')
      .send(params);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Confirmed');
    expect(await rsvp(apptId)).toBe('confirmed');
  });
});
