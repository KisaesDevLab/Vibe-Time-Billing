// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — auto-rename on upload (router-mode only). Producer + consumer.
//
// The consumer runs in the API process rather than apps/worker: pdfjs,
// @napi-rs/canvas, the AI gate (runAiCompletion) and the rename primitive
// all live here, and the worker has none of them. One BullMQ Worker,
// concurrency 2, started from server.ts; disable with
// FILE_AUTO_RENAME_CONSUMER=0 on replicas that should not consume.
//
// `maybeEnqueueAutoRename` is the cheap gate every write path calls:
// router mode, a renameable source, and the firm toggle (cached 30 s).
// It never throws — a failed enqueue must not fail the upload.

import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

import type { Database } from '@vibe/db';

import { getAiRuntime } from '../ai/ai-runtime';
import { logger } from '../logger';
import {
  NON_RENAMEABLE_SOURCES,
  applyAiRename,
  loadNamingSettings,
  recordSuggestionOnly,
  suggestFileName,
  type AiNamingDeps,
} from './ai-naming';

export const FILE_AUTO_RENAME_QUEUE = 'file-auto-rename';

export interface FileAutoRenameJob {
  firmId: string;
  fileId: string;
  actorAppUserId: string | null;
}

let queue: Queue<FileAutoRenameJob> | null = null;

function redisUrl(): string | null {
  return process.env['REDIS_URL'] ?? null;
}

export function getAutoRenameQueue(): Queue<FileAutoRenameJob> | null {
  if (queue) return queue;
  const url = redisUrl();
  if (!url) return null;
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  queue = new Queue<FileAutoRenameJob>(FILE_AUTO_RENAME_QUEUE, { connection });
  return queue;
}

/** BullMQ forbids ':' in custom job ids. */
export function autoRenameJobId(fileId: string): string {
  return `auto-rename-${fileId}`;
}

export async function enqueueAutoRename(job: FileAutoRenameJob): Promise<boolean> {
  const q = getAutoRenameQueue();
  if (!q) return false;
  await q.add('rename', job, {
    jobId: autoRenameJobId(job.fileId),
    attempts: 2,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { age: 24 * 3600 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
  return true;
}

// ---- gate -----------------------------------------------------------------------

const toggleCache = new Map<string, { on: boolean; at: number }>();
const TOGGLE_TTL_MS = 30_000;

export function _resetAutoRenameGateForTests(): void {
  toggleCache.clear();
}

async function firmAutoRenameOn(db: Database, firmId: string): Promise<boolean> {
  const hit = toggleCache.get(firmId);
  if (hit && Date.now() - hit.at < TOGGLE_TTL_MS) return hit.on;
  const s = await loadNamingSettings(db, firmId);
  toggleCache.set(firmId, { on: s.autoRenameUploads, at: Date.now() });
  return s.autoRenameUploads;
}

/**
 * Decide + enqueue. Returns true when a job was queued. Safe to call
 * fire-and-forget from any write path.
 */
export async function maybeEnqueueAutoRename(
  db: Database | null,
  job: FileAutoRenameJob & { source: string },
  enqueue: (j: FileAutoRenameJob) => Promise<boolean> = enqueueAutoRename,
): Promise<boolean> {
  try {
    if (getAiRuntime().mode !== 'router') {
      logger.debug({ fileId: job.fileId }, 'auto-rename skipped: not router mode');
      return false;
    }
    if (NON_RENAMEABLE_SOURCES.has(job.source)) return false;
    if (!db || !(await firmAutoRenameOn(db, job.firmId))) return false;
    return await enqueue({
      firmId: job.firmId,
      fileId: job.fileId,
      actorAppUserId: job.actorAppUserId,
    });
  } catch (err) {
    logger.warn({ err, fileId: job.fileId }, 'auto-rename enqueue failed');
    return false;
  }
}

// ---- consumer ---------------------------------------------------------------------

const PERMANENT_SKIPS = new Set([
  'not_router_mode',
  'file_not_found',
  'generated_source',
  'already_ai_renamed',
  'invalid_output',
  // Router config state (no vision-capable provider) — retrying won't help;
  // the operator fixes it in the router console.
  'no_vision_provider',
]);

/** The unit of work; exported so tests can drive it without BullMQ. */
export async function processAutoRenameJob(
  deps: AiNamingDeps,
  job: FileAutoRenameJob,
): Promise<'renamed' | 'suggested' | 'skipped' | 'retry'> {
  if (!deps.db) return 'skipped';
  const r = await suggestFileName(deps, {
    firmId: job.firmId,
    fileId: job.fileId,
    actorId: job.actorAppUserId,
    mode: 'auto',
  });
  if (!r.ok) {
    if (PERMANENT_SKIPS.has(r.skippedReason) || r.skippedReason === 'pending_upload') {
      if (r.skippedReason !== 'file_not_found' && r.skippedReason !== 'pending_upload') {
        await recordSuggestionOnly(deps.db, job.fileId, {
          proposed: null,
          confidence: null,
          model: null,
        });
      }
      return 'skipped';
    }
    // storage_unavailable / ai_unavailable / ai_failed → let BullMQ retry once.
    throw new Error(`auto-rename transient: ${r.skippedReason}`);
  }
  const settings = await loadNamingSettings(deps.db, job.firmId);
  if (r.confidence >= settings.minConfidence && r.proposed !== r.current) {
    const applied = await applyAiRename(deps, {
      firmId: job.firmId,
      fileId: job.fileId,
      newFilename: r.proposed,
      actorId: job.actorAppUserId,
      confidence: r.confidence,
      model: r.model,
    });
    if (applied.ok) return 'renamed';
    if (applied.code === 'storage_error') throw new Error('auto-rename transient: storage_error');
    return 'skipped';
  }
  await recordSuggestionOnly(deps.db, job.fileId, {
    proposed: r.proposed !== r.current ? r.proposed : null,
    confidence: r.confidence,
    model: r.model,
  });
  return 'suggested';
}

export function startAutoRenameConsumer(deps: AiNamingDeps): Worker<FileAutoRenameJob> | null {
  const url = redisUrl();
  if (
    !url ||
    process.env['FILE_AUTO_RENAME_CONSUMER'] === '0' ||
    process.env['NODE_ENV'] === 'test'
  ) {
    return null;
  }
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const worker = new Worker<FileAutoRenameJob>(
    FILE_AUTO_RENAME_QUEUE,
    async (job: Job<FileAutoRenameJob>) => {
      const outcome = await processAutoRenameJob(deps, job.data);
      logger.info({ fileId: job.data.fileId, outcome }, 'auto-rename job done');
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) => {
    logger.warn(
      { err, fileId: job?.data.fileId, attempts: job?.attemptsMade },
      'auto-rename job failed',
    );
  });
  logger.info({ queue: FILE_AUTO_RENAME_QUEUE }, 'auto-rename consumer started');
  return worker;
}
