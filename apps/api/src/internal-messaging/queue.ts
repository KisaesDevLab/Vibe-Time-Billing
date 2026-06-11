// SPDX-License-Identifier: Elastic-2.0
//
// Producer for internal-message notifications. POST a message → enqueue a
// debounced fan-out job; the worker emails/texts members who haven't read
// the thread since they were last notified. Dedicated lazy connection
// (maxRetriesPerRequest: null) per BullMQ.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const INTERNAL_MESSAGE_NOTIFY_QUEUE = 'internal-message-notify';

export interface InternalMessageNotifyJob {
  threadId: string;
  messageId: string;
  firmId: string;
  senderAppUserId: string;
}

let queue: Queue<InternalMessageNotifyJob> | null = null;

function getQueue(): Queue<InternalMessageNotifyJob> {
  if (queue) return queue;
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  queue = new Queue<InternalMessageNotifyJob>(INTERNAL_MESSAGE_NOTIFY_QUEUE, { connection });
  return queue;
}

export async function enqueueMessageNotify(job: InternalMessageNotifyJob): Promise<void> {
  // Small delay so a quick burst of messages coalesces (the worker
  // re-checks read state at run time and debounces per member).
  await getQueue().add('notify', job, {
    delay: 30_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}
