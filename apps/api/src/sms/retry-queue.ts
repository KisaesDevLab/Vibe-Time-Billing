// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Outbound SMS retry (addendum Phase 13). A send that fails with a
// retryable provider error (429 / 5xx / network) is re-queued with
// exponential backoff — 30 s · 2^attempt, capped at 8 minutes — up to 5
// attempts, then dead-lettered (surfaced in the thread + a notification).
// One job per message id; BullMQ dedupes same-id jobs, so a stale job is
// removed before re-adding. Mirrors notifications/staged/queue.ts.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const SMS_RETRY_QUEUE = 'sms-send-retry';
export const SMS_MAX_ATTEMPTS = 5;

export interface SmsRetryJob {
  messageId: string;
  firmId: string;
}

function isRedisDisabled(): boolean {
  return process.env['REDIS_DISABLED'] === '1' || process.env['NODE_ENV'] === 'test';
}

function buildQueue(): Queue<SmsRetryJob> {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  return new Queue<SmsRetryJob>(SMS_RETRY_QUEUE, { connection });
}

export function smsRetryJobId(messageId: string): string {
  return `sms-retry-${messageId}`;
}

/** Backoff for the Nth retry (attempt counts sends already made). */
export function smsRetryDelayMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 8 * 60_000);
}

export async function enqueueSmsRetry(job: SmsRetryJob, attempt: number): Promise<void> {
  if (isRedisDisabled()) return;
  const queue = buildQueue();
  const jobId = smsRetryJobId(job.messageId);
  try {
    await queue.remove(jobId).catch(() => undefined);
    await queue.add('retry', job, {
      jobId,
      delay: smsRetryDelayMs(attempt),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  } finally {
    await queue.close().catch(() => undefined);
  }
}
