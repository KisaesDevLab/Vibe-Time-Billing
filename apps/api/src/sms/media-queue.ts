// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Producer for inbound MMS media jobs (D7): fetch from Twilio → object
// storage → Document Intake → delete from Twilio. One job per sms_media
// row; the consumer runs in the API process (media-consumer.ts) because
// intake sessions need the firm key. Mirrors intake/queue.ts.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const SMS_MEDIA_QUEUE = 'sms-media';

export interface SmsMediaJob {
  mediaId: string;
  firmId: string;
}

let queue: Queue<SmsMediaJob> | null = null;

function isRedisDisabled(): boolean {
  return process.env['REDIS_DISABLED'] === '1' || process.env['NODE_ENV'] === 'test';
}

export function getSmsMediaQueue(): Queue<SmsMediaJob> {
  if (queue) return queue;
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  queue = new Queue<SmsMediaJob>(SMS_MEDIA_QUEUE, { connection });
  return queue;
}

export function smsMediaJobId(mediaId: string): string {
  return `sms-media-${mediaId}`;
}

/** Enqueue one media row. No-op when Redis is disabled (tests). */
export async function enqueueSmsMedia(job: SmsMediaJob): Promise<void> {
  if (isRedisDisabled()) return;
  await getSmsMediaQueue().add('fetch', job, {
    jobId: smsMediaJobId(job.mediaId),
    attempts: 5,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}
