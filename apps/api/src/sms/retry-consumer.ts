// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Consumer for sms-send-retry (API process, like the media consumer).
// Re-sends the stored body through the Messaging Service; re-checks the
// opt-out flag first so a STOP that arrived while the retry was queued
// wins (D9). After SMS_MAX_ATTEMPTS the row is dead-lettered, the sender
// (else the assignee) is notified, and the health card counts it.

import { Worker, type Job } from 'bullmq';
import { and, eq, sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { firmSettings, persons, smsConversations, smsMessages } from '@vibe/db/schema';

import { loadFirmTwilioInboxConfig } from '../messaging/sms-resolver';
import { mergeSmsHealth } from './health';
import { insertSmsNotifications } from './notify';
import { resolveSmsPublicBaseUrlFrom, smsWebhookUrls, type SmsPublicUrlConfig } from './public-url';
import {
  SMS_MAX_ATTEMPTS,
  SMS_RETRY_QUEUE,
  enqueueSmsRetry,
  type SmsRetryJob,
} from './retry-queue';
import type { SmsEvent } from './send-service';
import { createTwilioClient, TwilioApiError, type TwilioClient } from './twilio-client';

export interface SmsRetryConsumerDeps {
  db: Database | null;
  log: Logger;
  config: SmsPublicUrlConfig;
  publish?: (evt: SmsEvent) => Promise<void> | void;
  twilioClient?: (firmId: string) => Promise<TwilioClient | null>;
  enqueue?: typeof enqueueSmsRetry;
  now?: () => Date;
}

export type SmsRetryOutcome = 'sent' | 'requeued' | 'dead_letter' | 'skipped' | 'not_found';

export async function processSmsRetryJob(
  deps: SmsRetryConsumerDeps,
  job: SmsRetryJob,
): Promise<SmsRetryOutcome> {
  const { db, log } = deps;
  if (!db) return 'skipped';
  const now = deps.now ?? ((): Date => new Date());
  const [row] = await db
    .select({
      m: smsMessages,
      personId: smsConversations.personId,
      assignedUserId: smsConversations.assignedUserId,
      clientId: smsConversations.clientId,
    })
    .from(smsMessages)
    .innerJoin(smsConversations, eq(smsConversations.id, smsMessages.conversationId))
    .where(eq(smsMessages.id, job.messageId))
    .limit(1);
  if (!row) return 'not_found';
  const m = row.m;
  if (
    m.direction !== 'outbound' ||
    !['failed', 'queued'].includes(m.providerStatus) ||
    m.deadLetteredAt
  ) {
    return 'skipped';
  }
  // D9 — a STOP that landed while we were waiting wins.
  if (row.personId) {
    const [p] = await db
      .select({ optOut: persons.smsOptOut })
      .from(persons)
      .where(eq(persons.id, row.personId))
      .limit(1);
    if (p?.optOut) {
      await db
        .update(smsMessages)
        .set({
          providerStatus: 'failed',
          providerErrorMessage: 'opted out before retry',
          nextAttemptAt: null,
        })
        .where(eq(smsMessages.id, m.id));
      return 'skipped';
    }
  }
  const cfg = await loadFirmTwilioInboxConfig(db, m.firmId, log);
  const twilio =
    (deps.twilioClient ? await deps.twilioClient(m.firmId) : null) ??
    (cfg ? createTwilioClient(cfg, log) : null);
  if (!twilio || !cfg) return 'skipped';
  const [fs] = await db
    .select({ base: firmSettings.smsPublicBaseUrl })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, m.firmId))
    .limit(1);
  const statusCallback = smsWebhookUrls(
    resolveSmsPublicBaseUrlFrom(fs?.base, deps.config).baseUrl,
  ).status;
  const attempt = m.attemptCount + 1;
  try {
    const r = await twilio.sendMessage({
      to: m.toE164,
      body: m.body,
      messagingServiceSid: cfg.messagingServiceSid,
      statusCallback,
    });
    await db
      .update(smsMessages)
      .set({
        providerMessageId: r.sid,
        // reason: Twilio status vocabulary matches the CHECK list
        providerStatus: (r.status || 'queued') as 'queued',
        numSegments: r.numSegments,
        providerErrorCode: null,
        providerErrorMessage: null,
        attemptCount: attempt,
        nextAttemptAt: null,
      })
      .where(eq(smsMessages.id, m.id));
    await db
      .update(firmSettings)
      .set({ smsLastSendAt: now() })
      .where(eq(firmSettings.firmId, m.firmId));
    await deps.publish?.({
      type: 'sms.message.status',
      firmId: m.firmId,
      conversationId: m.conversationId,
      messageId: m.id,
      clientId: row.clientId,
    });
    return 'sent';
  } catch (err) {
    const twErr = err instanceof TwilioApiError ? err : null;
    const message = err instanceof Error ? err.message : 'twilio_failed';
    const retryable = twErr ? twErr.retryable : true;
    if (retryable && attempt < SMS_MAX_ATTEMPTS) {
      const delay = now().getTime() + 30_000 * 2 ** (attempt - 1);
      await db
        .update(smsMessages)
        .set({
          attemptCount: attempt,
          providerErrorCode: twErr?.code ?? null,
          providerErrorMessage: message.slice(0, 500),
          nextAttemptAt: new Date(Math.min(delay, now().getTime() + 8 * 60_000)),
        })
        .where(eq(smsMessages.id, m.id));
      await (deps.enqueue ?? enqueueSmsRetry)({ messageId: m.id, firmId: m.firmId }, attempt);
      return 'requeued';
    }
    await db
      .update(smsMessages)
      .set({
        attemptCount: attempt,
        providerStatus: 'dead_letter',
        providerErrorCode: twErr?.code ?? null,
        providerErrorMessage: message.slice(0, 500),
        deadLetteredAt: now(),
        nextAttemptAt: null,
      })
      .where(eq(smsMessages.id, m.id));
    await mergeSmsHealth(db, m.firmId, 'send', {
      deadLettered: Number(
        (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(smsMessages)
            .where(
              and(eq(smsMessages.firmId, m.firmId), eq(smsMessages.providerStatus, 'dead_letter')),
            )
        )[0]?.n ?? 0,
      ),
      lastError: message.slice(0, 200),
    }).catch(() => undefined);
    const recipient = m.sentByUserId ?? row.assignedUserId;
    if (recipient) {
      await insertSmsNotifications(db, {
        firmId: m.firmId,
        recipients: [recipient],
        type: 'sms_dead_letter',
        conversationId: m.conversationId,
        title: 'A text could not be delivered',
        body: `${m.body.slice(0, 100)} — gave up after ${attempt} attempts (${message.slice(0, 80)})`,
        metadata: { messageId: m.id },
      }).catch(() => undefined);
    }
    await deps.publish?.({
      type: 'sms.message.status',
      firmId: m.firmId,
      conversationId: m.conversationId,
      messageId: m.id,
      clientId: row.clientId,
    });
    return 'dead_letter';
  }
}

export function startSmsRetryConsumer(deps: SmsRetryConsumerDeps): Worker<SmsRetryJob> | null {
  const url = process.env['REDIS_URL'] ?? null;
  if (!url || process.env['SMS_RETRY_CONSUMER'] === '0' || process.env['NODE_ENV'] === 'test')
    return null;
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const worker = new Worker<SmsRetryJob>(
    SMS_RETRY_QUEUE,
    async (job: Job<SmsRetryJob>) => {
      const outcome = await processSmsRetryJob(deps, job.data);
      deps.log.info({ messageId: job.data.messageId, outcome }, 'sms-send-retry job done');
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) =>
    deps.log.warn({ err, messageId: job?.data.messageId }, 'sms-send-retry job failed'),
  );
  deps.log.info({ queue: SMS_RETRY_QUEUE }, 'sms-send-retry consumer started');
  return worker;
}
