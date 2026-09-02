// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — inbound Twilio webhook + ingestion: signature gate (proxy URL),
// conversation/message rows, unread bump, duplicate MessageSid → one row
// and unread stays 1, association to a known contact (+ suggested
// engagement + consent), STOP / START flip the person, a closed thread
// reopens, media rows + jobs enqueued, auto-discovered line, notifications
// to the line's default assignee, and the legacy appointment path alias.

import express from 'express';
import { eq, sql } from 'drizzle-orm';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clientCommunications,
  persons,
  smsConversations,
  smsLines,
  smsMedia,
  smsMessages,
  staffNotifications,
} from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { createAppointmentTwilioRouter } from '../appointments/twilio-routes';
import { ingestInboundMessage, type IngestDeps } from '../sms/ingest';
import { _resetInboxReaderCacheForTests } from '../sms/notify';
import { signTwilioRequest } from '../sms/twilio-signature';
import { createSmsWebhookRouter } from '../sms/webhook-routes';

const TOKEN = 'auth-token-xyz';
const PUBLIC = 'https://practice.example';
const PATH = '/api/sms/twilio/inbound';
const LINE = '+12025550100';
const log = pino({ enabled: false });

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let redis: Redis;
let enqueued: Array<{ mediaId: string; firmId: string }>;
let events: string[];
let sidN = 0;

function ingestDeps(): IngestDeps {
  return {
    db: harness.db,
    log,
    enqueueMedia: async (j) => {
      enqueued.push(j);
    },
    publish: (e) => {
      events.push(e.type);
    },
  };
}

function app() {
  const a = express();
  a.use(
    '/api/sms/twilio',
    createSmsWebhookRouter({
      db: harness.db,
      redis,
      log,
      config: { APP_BASE_URL: 'http://localhost:3001', PUBLIC_BASE_URL: PUBLIC },
      authTokens: [TOKEN],
      ingest: ingestInboundMessage,
      ingestDeps: ingestDeps(),
    }),
  );
  return a;
}

function form(overrides: Record<string, string> = {}): Record<string, string> {
  sidN += 1;
  return {
    MessageSid: `SM${String(sidN).padStart(32, '0')}`,
    From: '+13125550148',
    To: LINE,
    Body: 'Hello there',
    NumMedia: '0',
    SmsStatus: 'received',
    ...overrides,
  };
}

async function post(params: Record<string, string>, signedUrl = PUBLIC + PATH, token = TOKEN) {
  return request(app())
    .post(PATH)
    .set('X-Twilio-Signature', signTwilioRequest(token, signedUrl, params))
    .type('form')
    .send(params);
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  enqueued = [];
  events = [];
  _resetInboxReaderCacheForTests();
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
});

afterEach(async () => {
  await harness.close();
});

describe('POST /api/sms/twilio/inbound', () => {
  it('rejects a bad signature and creates nothing', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    const r = await post(form(), PUBLIC + PATH, 'nope');
    expect(r.status).toBe(403);
    expect(await harness.db.select().from(smsMessages)).toHaveLength(0);
  });

  it('creates the conversation + message, links the unique contact, suggests the only engagement, records consent, notifies', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    await harness.db
      .update(smsLines)
      .set({ defaultAssigneeUserId: seed.appUserId })
      .where(eq(smsLines.phoneNumberE164, LINE));
    const { personId, contactId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Client',
      mobile: '(312) 555-0148',
    });
    await harness.db.execute(
      sql`UPDATE engagement SET status = 'ACTIVE' WHERE id = ${seed.engagementId}`,
    );
    const r = await post(form({ Body: 'Can we do 3pm instead?' }));
    expect(r.status).toBe(200);
    expect(r.text).toContain('<Response></Response>');
    const [conv] = await harness.db.select().from(smsConversations);
    expect(conv!.externalNumberE164).toBe('+13125550148');
    expect(conv!.unreadCount).toBe(1);
    expect(conv!.personId).toBe(personId);
    expect(conv!.clientContactId).toBe(contactId);
    expect(conv!.clientId).toBe(seed.clientId);
    expect(conv!.engagementId).toBe(seed.engagementId);
    expect(conv!.engagementSuggested).toBe(true);
    expect(conv!.linkSource).toBe('phone');
    const [msg] = await harness.db.select().from(smsMessages);
    expect(msg!.direction).toBe('inbound');
    expect(msg!.body).toBe('Can we do 3pm instead?');
    expect(msg!.providerStatus).toBe('received');
    expect(msg!.ingestSource).toBe('webhook');
    expect(msg!.readAt).toBeNull();
    const [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsConsentSource).toBe('inbound');
    expect(p!.smsConsentAt).toBeTruthy();
    const comms = await harness.db.select().from(clientCommunications);
    expect(comms).toHaveLength(1);
    expect(comms[0]!.direction).toBe('INBOUND');
    const notes = await harness.db.select().from(staffNotifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.recipientAppUserId).toBe(seed.appUserId);
    expect(notes[0]!.title).toBe('Text from Pat Client');
    expect(notes[0]!.actionUrl).toBe(`/messages?tab=sms&c=${conv!.id}`);
    expect(events).toEqual(['sms.message.created', 'sms.conversation.updated']);
    const fs = await harness.db.execute(
      sql`SELECT sms_last_inbound_webhook_at AS t FROM firm_settings`,
    );
    expect((fs as unknown as { rows: { t: string | null }[] }).rows[0]!.t).toBeTruthy();
  });

  it('is idempotent on MessageSid — one row, unread stays 1', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    const params = form();
    expect((await post(params)).status).toBe(200);
    expect((await post(params)).status).toBe(200);
    expect(await harness.db.select().from(smsMessages)).toHaveLength(1);
    const [conv] = await harness.db.select().from(smsConversations);
    expect(conv!.unreadCount).toBe(1);
  });

  it('threads a second text into the same conversation and reopens a closed one', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    await post(form({ Body: 'one' }));
    await harness.db.update(smsConversations).set({ status: 'closed', unreadCount: 0 });
    await post(form({ Body: 'two' }));
    const convs = await harness.db.select().from(smsConversations);
    expect(convs).toHaveLength(1);
    expect(convs[0]!.status).toBe('open');
    expect(convs[0]!.unreadCount).toBe(1);
    expect(await harness.db.select().from(smsMessages)).toHaveLength(2);
  });

  it('STOP opts the person out (no notification); START clears it', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: '+13125550148',
    });
    await post(form({ Body: 'STOP' }));
    let [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(true);
    expect(p!.smsOptOutSource).toBe('inbound_stop');
    expect(await harness.db.select().from(staffNotifications)).toHaveLength(0);
    await post(form({ Body: 'yes please', OptOutType: 'START' }));
    [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(false);
    expect(p!.smsConsentSource).toBe('inbound');
  });

  it('records MMS media rows and enqueues fetch jobs', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    await harness.db
      .update(smsLines)
      .set({ defaultAssigneeUserId: seed.appUserId })
      .where(eq(smsLines.phoneNumberE164, LINE));
    const AC = 'AC' + 'a'.repeat(32);
    const r = await post(
      form({
        Body: '',
        NumMedia: '2',
        MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/MM${'1'.repeat(32)}/Media/ME${'a'.repeat(32)}`,
        MediaContentType0: 'image/jpeg',
        MediaUrl1: `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/MM${'1'.repeat(32)}/Media/ME${'b'.repeat(32)}`,
        MediaContentType1: 'application/pdf',
      }),
    );
    expect(r.status).toBe(200);
    const media = await harness.db.select().from(smsMedia);
    expect(media).toHaveLength(2);
    expect(media.map((m) => m.providerMediaSid).sort()).toEqual([
      `ME${'a'.repeat(32)}`,
      `ME${'b'.repeat(32)}`,
    ]);
    expect(media.every((m) => m.status === 'pending')).toBe(true);
    expect(enqueued).toHaveLength(2);
    const [msg] = await harness.db.select().from(smsMessages);
    expect(msg!.numMedia).toBe(2);
    const notes = await harness.db.select().from(staffNotifications);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.body).toContain('attachment');
  });

  it('auto-discovers an unknown firm number as a line', async () => {
    const r = await post(form({ To: '+12025550177' }));
    expect(r.status).toBe(200);
    const lines = await harness.db.select().from(smsLines);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.label).toBe('Auto-discovered');
    expect(lines[0]!.isDefault).toBe(true);
    expect(await harness.db.select().from(smsMessages)).toHaveLength(1);
  });

  it('ignores texts to a line with ingest off', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE, ingest: false });
    const r = await post(form());
    expect(r.status).toBe(200);
    expect(await harness.db.select().from(smsMessages)).toHaveLength(0);
  });

  it('flags needs_triage when two clients share the number', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    const other = await harness.db.execute(
      sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
          SELECT firm_id, 'Other Co', partner_in_charge_id, office_id FROM client WHERE id = ${seed.clientId} RETURNING id`,
    );
    const otherId = (other as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'A',
      mobile: '+13125550148',
    });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: otherId,
      fullName: 'B',
      phone: '312-555-0148',
    });
    await post(form());
    const [conv] = await harness.db.select().from(smsConversations);
    expect(conv!.needsTriage).toBe(true);
    expect(conv!.clientId).toBeNull();
    expect((conv!.candidatePersonIds as string[]).length).toBe(2);
  });
});

describe('legacy /api/public/appointments/twilio/sms alias', () => {
  it('ingests into the inbox first and skips the old timeline log', async () => {
    await seedSmsLine(harness.db, { firmId: seed.firmId, number: LINE });
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: '+13125550148',
    });
    const deps = ingestDeps();
    const a = express();
    a.use(
      '/api/public/appointments/twilio',
      createAppointmentTwilioRouter({
        db: harness.db,
        redis,
        baseUrl: 'http://localhost:5173',
        authTokens: [TOKEN],
        ingest: (msg) => ingestInboundMessage(deps, msg, { source: 'webhook' }),
      }),
    );
    const params = form({ Body: 'running late' });
    const url = 'http://localhost:5173/api/public/appointments/twilio/sms';
    const r = await request(a)
      .post('/api/public/appointments/twilio/sms')
      .set('X-Twilio-Signature', signTwilioRequest(TOKEN, url, params))
      .type('form')
      .send(params);
    expect(r.status).toBe(200);
    expect(await harness.db.select().from(smsMessages)).toHaveLength(1);
    // exactly one Communications row (from ingest, not the legacy logger)
    expect(await harness.db.select().from(clientCommunications)).toHaveLength(1);
  });
});
