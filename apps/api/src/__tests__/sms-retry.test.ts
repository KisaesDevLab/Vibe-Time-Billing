// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 13 — retry/dead-letter: a retryable failure re-queues with the
// attempt count bumped; a STOP that landed while queued wins; after the
// cap the row is dead-lettered and the sender is notified; the manual
// retry endpoint resets a dead-lettered row.

import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { crypto as core } from '@vibe/core';
import { persons, smsConversations, smsMessages, staffNotifications } from '@vibe/db/schema';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { processSmsRetryJob } from '../sms/retry-consumer';
import { smsRetryDelayMs } from '../sms/retry-queue';
import { TwilioApiError, type TwilioClient } from '../sms/twilio-client';

const KMS_KEY = 'a'.repeat(64);
const AC = 'AC' + 'a'.repeat(32);
const MG = 'MG' + 'b'.repeat(32);
const log = pino({ enabled: false });

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let messageId: string;
let personId: string;
let reply: () => Promise<{ sid: string; status: string; numSegments: number }>;
let enqueued: Array<{ messageId: string; attempt: number }>;

function twilio(): TwilioClient {
  return {
    async sendMessage() {
      return reply();
    },
  } as unknown as TwilioClient;
}

function deps() {
  return {
    db: harness.db,
    log,
    config: { APP_BASE_URL: 'http://localhost:3001' },
    twilioClient: async () => twilio(),
    enqueue: async (job: { messageId: string }, attempt: number) => {
      enqueued.push({ messageId: job.messageId, attempt });
    },
  };
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  process.env['KMS_KEY'] = KMS_KEY;
  enqueued = [];
  reply = async () => ({ sid: 'SMOK', status: 'queued', numSegments: 1 });
  const envelope = core.encryptJson(
    { provider: 'twilio', accountSid: AC, authToken: 'token-12345', messagingServiceSid: MG },
    core.resolveKey(KMS_KEY),
  );
  await harness.db.execute(
    sql`INSERT INTO firm_settings (firm_id, sms_config_encrypted, sms_inbox_enabled) VALUES (${seed.firmId}, ${envelope}, true)`,
  );
  const { lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId });
  ({ personId } = await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Pat',
    mobile: '+13125550148',
  }));
  const [conv] = await harness.db
    .insert(smsConversations)
    .values({
      firmId: seed.firmId,
      lineId,
      externalNumberE164: '+13125550148',
      personId,
      assignedUserId: seed.appUserId,
    })
    .returning({ id: smsConversations.id });
  const [m] = await harness.db
    .insert(smsMessages)
    .values({
      firmId: seed.firmId,
      conversationId: conv!.id,
      direction: 'outbound',
      fromE164: '+12025550100',
      toE164: '+13125550148',
      body: 'hello',
      providerStatus: 'failed',
      contextKind: 'manual',
      sentByUserId: seed.appUserId,
      attemptCount: 1,
    })
    .returning({ id: smsMessages.id });
  messageId = m!.id;
});

afterEach(async () => {
  await harness.close();
});

describe('sms retry', () => {
  it('backoff grows and caps', () => {
    expect(smsRetryDelayMs(1)).toBe(30_000);
    expect(smsRetryDelayMs(2)).toBe(60_000);
    expect(smsRetryDelayMs(6)).toBe(8 * 60_000);
  });

  it('a successful retry records the sid and clears the error', async () => {
    expect(await processSmsRetryJob(deps(), { messageId, firmId: seed.firmId })).toBe('sent');
    const [m] = await harness.db.select().from(smsMessages).where(eq(smsMessages.id, messageId));
    expect(m!.providerMessageId).toBe('SMOK');
    expect(m!.providerStatus).toBe('queued');
    expect(m!.attemptCount).toBe(2);
    expect(m!.nextAttemptAt).toBeNull();
  });

  it('a retryable failure re-queues with the next attempt; the cap dead-letters and notifies', async () => {
    reply = async () => {
      throw new TwilioApiError('busy', 503, null);
    };
    expect(await processSmsRetryJob(deps(), { messageId, firmId: seed.firmId })).toBe('requeued');
    expect(enqueued).toEqual([{ messageId, attempt: 2 }]);
    await harness.db
      .update(smsMessages)
      .set({ attemptCount: 4 })
      .where(eq(smsMessages.id, messageId));
    expect(await processSmsRetryJob(deps(), { messageId, firmId: seed.firmId })).toBe(
      'dead_letter',
    );
    const [m] = await harness.db.select().from(smsMessages).where(eq(smsMessages.id, messageId));
    expect(m!.providerStatus).toBe('dead_letter');
    expect(m!.deadLetteredAt).toBeTruthy();
    const notes = await harness.db.select().from(staffNotifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe('sms_dead_letter');
    expect(notes[0]!.recipientAppUserId).toBe(seed.appUserId);
  });

  it('a non-retryable error dead-letters immediately', async () => {
    reply = async () => {
      throw new TwilioApiError('bad number', 400, 21211);
    };
    expect(await processSmsRetryJob(deps(), { messageId, firmId: seed.firmId })).toBe(
      'dead_letter',
    );
  });

  it('a STOP that landed while queued wins', async () => {
    await harness.db.update(persons).set({ smsOptOut: true }).where(eq(persons.id, personId));
    expect(await processSmsRetryJob(deps(), { messageId, firmId: seed.firmId })).toBe('skipped');
    const [m] = await harness.db.select().from(smsMessages).where(eq(smsMessages.id, messageId));
    expect(m!.providerStatus).toBe('failed');
    expect(m!.providerErrorMessage).toContain('opted out');
  });
});
