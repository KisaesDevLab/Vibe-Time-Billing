// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 13 — fixture-driven webhook tests: every Twilio request fixture is
// signed against the firm's PUBLIC origin (with and without the explicit
// default port) and posted to the internal mount, exercising the
// proxy-URL signature case end to end.

import express from 'express';
import { eq, sql } from 'drizzle-orm';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { pino } from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persons, smsMedia, smsMessages } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { loadTwilioFixture, signFixture, urlVariants } from './_twilio-sign';
import { ingestInboundMessage } from '../sms/ingest';
import { _resetInboxReaderCacheForTests } from '../sms/notify';
import { createSmsWebhookRouter } from '../sms/webhook-routes';

const TOKEN = 'fixture-token';
const PUBLIC = 'https://practice.example';
const log = pino({ enabled: false });

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let redis: Redis;
let enqueued: string[];

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
      ingestDeps: {
        db: harness.db,
        log,
        enqueueMedia: async (j) => {
          enqueued.push(j.mediaId);
        },
      },
    }),
  );
  return a;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  enqueued = [];
  _resetInboxReaderCacheForTests();
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
  await seedSmsLine(harness.db, { firmId: seed.firmId, number: '+12025550100' });
});

afterEach(async () => {
  await harness.close();
});

describe('Twilio fixtures', () => {
  for (const variant of urlVariants(PUBLIC, '/api/sms/twilio/inbound')) {
    it(`inbound-sms signed as ${variant} is accepted`, async () => {
      const params = loadTwilioFixture('inbound-sms');
      const r = await request(app())
        .post('/api/sms/twilio/inbound')
        .set('X-Twilio-Signature', signFixture(TOKEN, variant, params))
        .type('form')
        .send(params);
      expect(r.status).toBe(200);
      expect(await harness.db.select().from(smsMessages)).toHaveLength(1);
    });
  }

  it('inbound-mms creates a media row and job', async () => {
    const params = loadTwilioFixture('inbound-mms');
    const r = await request(app())
      .post('/api/sms/twilio/inbound')
      .set('X-Twilio-Signature', signFixture(TOKEN, PUBLIC + '/api/sms/twilio/inbound', params))
      .type('form')
      .send(params);
    expect(r.status).toBe(200);
    const media = await harness.db.select().from(smsMedia);
    expect(media).toHaveLength(1);
    expect(media[0]!.contentType).toBe('image/jpeg');
    expect(enqueued).toHaveLength(1);
  });

  it('inbound-stop opts the matched contact out', async () => {
    const { personId } = await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat',
      mobile: '+13125550148',
    });
    const params = loadTwilioFixture('inbound-stop');
    await request(app())
      .post('/api/sms/twilio/inbound')
      .set('X-Twilio-Signature', signFixture(TOKEN, PUBLIC + '/api/sms/twilio/inbound', params))
      .type('form')
      .send(params);
    const [p] = await harness.db.select().from(persons).where(eq(persons.id, personId));
    expect(p!.smsOptOut).toBe(true);
  });

  it('a fixture signed for the wrong host is rejected', async () => {
    const params = loadTwilioFixture('inbound-sms');
    const r = await request(app())
      .post('/api/sms/twilio/inbound')
      .set(
        'X-Twilio-Signature',
        signFixture(TOKEN, 'https://evil.example/api/sms/twilio/inbound', params),
      )
      .type('form')
      .send(params);
    expect(r.status).toBe(403);
  });
});
