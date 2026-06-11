// SPDX-License-Identifier: Elastic-2.0
//
// R4-followup — BullMQ delayed-job scheduling for retainer notifications.
//
// Two queues, both delayed-only (no cron). The worker registers parallel
// queue/worker pairs via setupRetainerDelayedQueues() in apps/worker.
//
//   retainer-offer-reminder  — enqueued at offer creation (R2).
//     On-bill / day-30 / day-55 reminders, each gated by a firm-settings
//     boolean. Cancelled on portal purchase / decline (R3) or offer
//     expiry sweep (R4).
//
//   retainer-expiry-warning  — enqueued at activation (R3 + R7 manual).
//     90d / 60d / 30d / 7d before expiry. Cancelled when the retainer is
//     voided, exhausted, or paused (firm-action paths).
//
// Job IDs are deterministic ("retainer-offer-reminder:{offerId}:onbill")
// so redeploys or retried inserts don't double-schedule; BullMQ dedupes
// on jobId at queue.add time.
//
// All helpers are best-effort — failures log and return. They are
// designed to be called AFTER the surrounding DB transaction commits so
// a tx rollback doesn't strand a queue entry that points at a
// non-existent offer/retainer. Worker handlers MUST defensively look
// up the target row and silently skip if it's gone or in a terminal
// state.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

import { logger } from '../logger';

export const OFFER_REMINDER_QUEUE = 'retainer-offer-reminder';
export const EXPIRY_WARNING_QUEUE = 'retainer-expiry-warning';

export type OfferReminderKind = 'onbill' | 'day30' | 'day55';
export type ExpiryWarningKind = '90d' | '60d' | '30d' | '7d';

export interface OfferReminderPayload {
  offerId: string;
  kind: OfferReminderKind;
}

export interface ExpiryWarningPayload {
  retainerId: string;
  kind: ExpiryWarningKind;
}

const MS_PER_DAY = 24 * 3600_000;
// "On-bill" reminder fires shortly after the invoice goes out — 5 min
// gives the surrounding invoice email + mail provider time to settle so
// the client gets the bill first, then a friendly nudge about the
// retainer option. Keep small so the queue doesn't accumulate jobs
// during an outage window.
const ONBILL_DELAY_MS = 5 * 60_000;

function isRedisDisabled(): boolean {
  // Tests + offline dev skip the queue entirely.
  return process.env['REDIS_DISABLED'] === '1' || process.env['NODE_ENV'] === 'test';
}

function buildQueue<T>(name: string): Queue<T> {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  return new Queue<T>(name, { connection });
}

export interface ScheduleOfferRemindersArgs {
  offerId: string;
  notifyOnBill: boolean;
  notifyDay30: boolean;
  notifyDay55: boolean;
}

export async function scheduleOfferReminders(args: ScheduleOfferRemindersArgs): Promise<string[]> {
  if (isRedisDisabled()) return [];
  const queue = buildQueue<OfferReminderPayload>(OFFER_REMINDER_QUEUE);
  const scheduled: string[] = [];
  try {
    if (args.notifyOnBill) {
      const jobId = `retainer-offer-reminder:${args.offerId}:onbill`;
      await queue.add(
        'reminder',
        { offerId: args.offerId, kind: 'onbill' },
        { jobId, delay: ONBILL_DELAY_MS, removeOnComplete: true },
      );
      scheduled.push(jobId);
    }
    if (args.notifyDay30) {
      const jobId = `retainer-offer-reminder:${args.offerId}:day30`;
      await queue.add(
        'reminder',
        { offerId: args.offerId, kind: 'day30' },
        { jobId, delay: 30 * MS_PER_DAY, removeOnComplete: true },
      );
      scheduled.push(jobId);
    }
    if (args.notifyDay55) {
      const jobId = `retainer-offer-reminder:${args.offerId}:day55`;
      await queue.add(
        'reminder',
        { offerId: args.offerId, kind: 'day55' },
        { jobId, delay: 55 * MS_PER_DAY, removeOnComplete: true },
      );
      scheduled.push(jobId);
    }
    logger.info({ offerId: args.offerId, scheduled }, 'retainer offer reminders scheduled');
  } catch (err) {
    logger.error({ err, offerId: args.offerId }, 'retainer offer reminder scheduling failed');
  } finally {
    await queue.close().catch(() => undefined);
  }
  return scheduled;
}

export async function cancelOfferReminders(offerId: string): Promise<void> {
  if (isRedisDisabled()) return;
  const queue = buildQueue<OfferReminderPayload>(OFFER_REMINDER_QUEUE);
  try {
    for (const kind of ['onbill', 'day30', 'day55'] as const) {
      const jobId = `retainer-offer-reminder:${offerId}:${kind}`;
      await queue
        .remove(jobId)
        .catch((err: unknown) =>
          logger.warn({ err, jobId, offerId }, 'retainer offer reminder removal failed'),
        );
    }
    logger.info({ offerId }, 'retainer offer reminders cancelled');
  } catch (err) {
    logger.error({ err, offerId }, 'retainer offer reminder cancel failed');
  } finally {
    await queue.close().catch(() => undefined);
  }
}

export interface ScheduleRetainerWarningsArgs {
  retainerId: string;
  /** ISO YYYY-MM-DD. */
  expiryDate: string;
  /** Override for tests so they don't depend on wall-clock. */
  now?: Date;
}

export async function scheduleRetainerWarnings(
  args: ScheduleRetainerWarningsArgs,
): Promise<string[]> {
  if (isRedisDisabled()) return [];
  const queue = buildQueue<ExpiryWarningPayload>(EXPIRY_WARNING_QUEUE);
  const scheduled: string[] = [];
  try {
    const expiryMs = new Date(args.expiryDate + 'T00:00:00Z').getTime();
    const nowMs = (args.now ?? new Date()).getTime();
    const stages: ReadonlyArray<[ExpiryWarningKind, number]> = [
      ['90d', 90],
      ['60d', 60],
      ['30d', 30],
      ['7d', 7],
    ];
    for (const [kind, days] of stages) {
      const delay = expiryMs - nowMs - days * MS_PER_DAY;
      if (delay <= 0) continue;
      const jobId = `retainer-expiry-warning:${args.retainerId}:${kind}`;
      await queue.add(
        'warning',
        { retainerId: args.retainerId, kind },
        { jobId, delay, removeOnComplete: true },
      );
      scheduled.push(jobId);
    }
    logger.info({ retainerId: args.retainerId, scheduled }, 'retainer warnings scheduled');
  } catch (err) {
    logger.error({ err, retainerId: args.retainerId }, 'retainer warning scheduling failed');
  } finally {
    await queue.close().catch(() => undefined);
  }
  return scheduled;
}

export async function cancelRetainerWarnings(retainerId: string): Promise<void> {
  if (isRedisDisabled()) return;
  const queue = buildQueue<ExpiryWarningPayload>(EXPIRY_WARNING_QUEUE);
  try {
    for (const kind of ['90d', '60d', '30d', '7d'] as const) {
      const jobId = `retainer-expiry-warning:${retainerId}:${kind}`;
      await queue
        .remove(jobId)
        .catch((err: unknown) =>
          logger.warn({ err, jobId, retainerId }, 'retainer expiry warning removal failed'),
        );
    }
    logger.info({ retainerId }, 'retainer warnings cancelled');
  } catch (err) {
    logger.error({ err, retainerId }, 'retainer warning cancel failed');
  } finally {
    await queue.close().catch(() => undefined);
  }
}
