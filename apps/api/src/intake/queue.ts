// SPDX-License-Identifier: Elastic-2.0
//
// Producer side of the intake-process pipeline. POST /session/:id/complete
// enqueues one job per completed session; the worker consumer (Phase D)
// runs the ClamAV scan → image→PDF assembly → MFK-encrypt → notify chain.
// Until Phase D lands, enqueued jobs simply wait in Redis (no consumer),
// which is harmless.
//
// A dedicated lazy connection (maxRetriesPerRequest: null, required by
// BullMQ) mirrors the retainer scheduler's queue factory rather than
// borrowing the request-path ioredis client.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const INTAKE_PROCESS_QUEUE = 'intake-process';

export interface IntakeProcessJob {
  sessionId: string;
  firmId: string;
}

let queue: Queue<IntakeProcessJob> | null = null;

export function getIntakeQueue(): Queue<IntakeProcessJob> {
  if (queue) return queue;
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  queue = new Queue<IntakeProcessJob>(INTAKE_PROCESS_QUEUE, { connection });
  return queue;
}

/** Deterministic job id for a session. BullMQ forbids ':' in a custom
 *  jobId, so we use a dash-joined form; the session id is already unique,
 *  so an accidental double-complete coalesces into one job. */
export function intakeJobId(sessionId: string): string {
  return `intake-process-${sessionId}`;
}

/** Enqueue a completed session for the worker pipeline. */
export async function enqueueIntakeProcess(job: IntakeProcessJob): Promise<void> {
  await getIntakeQueue().add('process', job, {
    jobId: intakeJobId(job.sessionId),
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}
