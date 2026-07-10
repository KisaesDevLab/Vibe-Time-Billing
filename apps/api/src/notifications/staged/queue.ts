// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0146 — BullMQ producer for the staged-notification send queue.
//
// One delayed-only queue. Job IDs are deterministic
// ("staged-notification-send:{stagedNotificationId}") so re-decides
// don't double-schedule; re-scheduling an already-queued row removes
// the old job first (BullMQ won't replace a job with the same id).
//
// Helpers are best-effort (log-and-return) and are called AFTER the
// surrounding DB transaction commits. The worker handler defensively
// reloads the row and skips unless it is still SCHEDULED.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { logger } from '../../logger';

export const STAGED_NOTIFICATION_SEND_QUEUE = 'staged-notification-send';

export interface StagedNotificationSendPayload {
  stagedNotificationId: string;
}

function isRedisDisabled(): boolean {
  // Tests + offline dev skip the queue entirely.
  return process.env['REDIS_DISABLED'] === '1' || process.env['NODE_ENV'] === 'test';
}

function buildQueue(): Queue<StagedNotificationSendPayload> {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  return new Queue<StagedNotificationSendPayload>(STAGED_NOTIFICATION_SEND_QUEUE, { connection });
}

function jobIdFor(stagedNotificationId: string): string {
  return `staged-notification-send:${stagedNotificationId}`;
}

/** Enqueue a send; omit fireAt (or pass a past date) for immediate. */
export async function enqueueStagedSend(
  stagedNotificationId: string,
  fireAt?: Date,
): Promise<void> {
  if (isRedisDisabled()) return;
  const queue = buildQueue();
  const jobId = jobIdFor(stagedNotificationId);
  try {
    // Same-id jobs are deduped, not replaced — drop any stale schedule
    // before adding so a re-decide takes effect.
    await queue.remove(jobId).catch(() => undefined);
    const delay = fireAt ? Math.max(0, fireAt.getTime() - Date.now()) : 0;
    await queue.add(
      'send',
      { stagedNotificationId },
      { jobId, delay, attempts: 1, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
    );
    logger.info({ stagedNotificationId, delay }, 'staged notification send enqueued');
  } catch (err) {
    logger.error({ err, stagedNotificationId }, 'staged notification enqueue failed');
  } finally {
    await queue.close().catch(() => undefined);
  }
}

export async function cancelStagedSend(stagedNotificationId: string): Promise<void> {
  if (isRedisDisabled()) return;
  const queue = buildQueue();
  try {
    await queue.remove(jobIdFor(stagedNotificationId)).catch((err: unknown) => {
      logger.warn({ err, stagedNotificationId }, 'staged notification job removal failed');
    });
  } finally {
    await queue.close().catch(() => undefined);
  }
}
