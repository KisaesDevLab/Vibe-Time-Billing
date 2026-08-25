// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Producer side of the Vibe Filer route pipeline. POST /filer/commit
// enqueues one idempotent job per included inbox row (copy → log →
// delete); undo enqueues one job per routed log row. Dedicated lazy
// BullMQ connection (maxRetriesPerRequest: null), mirroring intake/queue.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { K1RouteConfig } from '@vibe/core/filer';

export const FILER_ROUTE_QUEUE = 'filer-route';

export type FilerRouteJob =
  | {
      kind: 'route';
      firmId: string;
      actorId: string;
      batchId: string;
      itemId: string;
      /**
       * 0229 — K-1 recipient-copy destination, resolved ONCE at commit so
       * the whole batch files consistently even if the profile is edited
       * mid-batch. Older queued jobs without it fall back to a live load.
       */
      k1Config?: K1RouteConfig;
    }
  | { kind: 'undo'; firmId: string; actorId: string; logId: string };

let queue: Queue<FilerRouteJob> | null = null;

export function getFilerQueue(): Queue<FilerRouteJob> {
  if (queue) return queue;
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  queue = new Queue<FilerRouteJob>(FILER_ROUTE_QUEUE, { connection });
  return queue;
}

const jobOpts = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export async function enqueueFilerRoute(job: {
  firmId: string;
  actorId: string;
  batchId: string;
  itemId: string;
  k1Config?: K1RouteConfig;
}): Promise<void> {
  await getFilerQueue().add(
    'route',
    { kind: 'route', ...job },
    { jobId: `filer-route-${job.batchId}-${job.itemId}`, ...jobOpts },
  );
}

export async function enqueueFilerUndo(job: {
  firmId: string;
  actorId: string;
  logId: string;
}): Promise<void> {
  await getFilerQueue().add(
    'undo',
    { kind: 'undo', ...job },
    { jobId: `filer-undo-${job.logId}`, ...jobOpts },
  );
}

// ── 0153 — zip import ─────────────────────────────────────────────────

export const ZIP_IMPORT_QUEUE = 'zip-import';

export interface ZipImportJob {
  importId: string;
  firmId: string;
  actorId: string;
}

let zipQueue: Queue<ZipImportJob> | null = null;

export function getZipImportQueue(): Queue<ZipImportJob> {
  if (zipQueue) return zipQueue;
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  zipQueue = new Queue<ZipImportJob>(ZIP_IMPORT_QUEUE, { connection });
  return zipQueue;
}

export async function enqueueZipImport(job: ZipImportJob): Promise<void> {
  await getZipImportQueue().add('import', job, {
    jobId: `zip-import-${job.importId}`,
    ...jobOpts,
  });
}
