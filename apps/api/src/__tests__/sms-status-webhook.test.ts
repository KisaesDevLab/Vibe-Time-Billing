// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — signed Twilio status callback: updates sms_message + the
// notification_log row, refuses bad signatures, verifies against the
// PUBLIC origin (proxy case), never regresses a terminal status, and
// flips the person to opted-out on error 21610.

import express from 'express';
import { eq, sql } from 'drizzle-orm';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { notificationLog, persons, smsConversations, smsMessages } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { signTwilioRequest } from '../sms/twilio-signature';
import { createSmsWebhookRouter } from '../sms/webhook-routes';

const TOKEN = 'auth-token-xyz';
const PUBLIC = 'https://practice.example';
const PATH = '/api/sms/twilio/status';
const log = pino({ enabled: false });

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let redis: Redis;
let conversationId: string;
let messageId: string;
let personId: string;

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
    }),
  );
  return a;
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
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
  const { lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId });
  ({ personId } = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Pat',
    mobile: '+12025550199',
  }));
  const [conv] = await harness.db
    .insert(smsConversations)
    .values({ firmId: seed.firmId, lineId, externalNumberE164: '+12025550199', personId })
    .returning({ id: smsConversations.id });
  conversationId = conv!.id;
  const [msg] = await harness.db
    .insert(smsMessages)
    .values({
      firmId: seed.firmId,
      conversationId,
      direction: 'outbound',
      fromE164: '+12025550100',
      toE164: '+12025550199',
      body: 'hi',
      providerMessageId: 'SM1',
      providerStatus: 'sent',
      contextKind: 'manual',
    })
    .returning({ id: smsMessages.id });
  messageId = msg!.id;
  await harness.db.insert(notificationLog).values({
    firmId: seed.firmId,
    channel: 'sms',
    provider: 'twilio',
    recipient: '+12025550199',
    status: 'sent',
    providerMessageId: 'SM1',
  });
});

afterEach(async () => {
  await harness.close();
});

describe('POST /api/sms/twilio/status', () => {
  it('rejects a bad signature (403) and counts it in health', async () => {
    const r = await post({ MessageSid: 'SM1', MessageStatus: 'delivered' }, PUBLIC + PATH, 'wrong');
    expect(r.status).toBe(403);
    const [msg] = await harness.db.select().from(smsMessages).where(eq(smsMessages.id, messageId));
    expect(msg!.providerStatus).toBe('sent');
    const h = await harness.db.execute(sql`SELECT sms_health FROM firm_settings`);
    const health = (
      h as unknown as { rows: { sms_health: { webhook?: { invalidSignature24h?: number } } }[] }
    ).rows[0]!.sms_health;
    expect(health.webhook?.invalidSignature24h).toBe(1);
  });

  it('accepts a signature computed over the PUBLIC url (request arrived on localhost)', async () => {
    const r = await post({ MessageSid: 'SM1', MessageStatus: 'delivered' });
    expect(r.status).toBe(204);
    const [msg] = await harness.db.select().from(smsMessages).where(eq(smsMessages.id, messageId));
    expect(msg!.providerStatus).toBe('delivered');
    expect(msg!.providerTimestamp).toBeTruthy();
    const [logRow] = await harness.db.select().from(notificationLog);
    expect(logRow!.status).toBe('delivered');
    const fs = await harness.db.execute(
      sql`SELECT sms_last_status_webhook_at AS t FROM firm_settings`,
    );
    expect((fs as unknown as { rows: { t: string | null }[] }).rows[0]!.t).toBeTruthy();
  });

  it('also accepts the APP_BASE_URL-signed form and is idempotent / non-regressing', async () => {
    expect(
      (
        await post(
          { MessageSid: 'SM1', MessageStatus: 'delivered' },
          'http://localhost:3001' + PATH,
        )
      ).status,
    ).toBe(204);
    // A late "sent" after "delivered" must not regress the terminal state.
    expect((await post({ MessageSid: 'SM1', MessageStatus: 'sent' })).status).toBe(204);
    const [msg] = await harness.db.select().from(smsMessages).where(eq(smsMessages.id, messageId));
    expect(msg!.providerStatus).toBe('delivered');
    expect((await post({ MessageSid: 'SM1', MessageStatus: 'delivered' })).status).toBe(204);
  });

  it('records the error code and flips opt-out on 21610', async () => {
    const r = await post({
      MessageSid: 'SM1',
      MessageStatus: 'failed',
      ErrorCode: '21610',
      ErrorMessage: 'Attempt to send to unsubscribed recipient',
    });
    expect(r.status).toBe(204);
    const [msg] = await harness.db.select().from(smsMessages).where(eq(smsMessages.id, messageId));
    expect(msg!.providerStatus).toBe('failed');
    expect(msg!.providerErrorCode).toBe(21610);
    const [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(true);
    expect(p!.smsOptOutSource).toBe('provider_21610');
    const [logRow] = await harness.db.select().from(notificationLog);
    expect(logRow!.status).toBe('failed');
  });

  it('ignores unknown sids quietly', async () => {
    const r = await post({ MessageSid: 'SM999', MessageStatus: 'delivered' });
    expect(r.status).toBe(204);
  });
});
