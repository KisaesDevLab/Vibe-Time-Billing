// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// SHA-256 hashing worker (Phase 5 of FILE_MANAGER_ADDENDUM.md).
//
// Picks up `files` rows where:
//   - sha256 IS NULL
//   - deleted_at IS NULL
//   - pending_upload = false (a Phase-8 reservation slot is not a real
//     object yet)
//   - size_bytes < HASH_SIZE_LIMIT_BYTES (default 100MB)
//
// For each, streams the object body through crypto.createHash('sha256')
// and writes the hex digest back. Bounded per tick by HASH_BATCH_SIZE
// so a long backlog doesn't starve other workers.
//
// Idempotent: rows that already have a hash are filtered out by the
// query, so a re-run picks up where the last one left off.

import { createHash } from 'node:crypto';

import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { files } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_SIZE_LIMIT_BYTES = 100 * 1024 * 1024;

export interface HashFileTickOpts {
  batchSize?: number;
  sizeLimitBytes?: number;
}

export interface HashFileTickResult {
  hashed: number;
  failed: number;
  skipped: boolean;
  skipReason?: string;
}

export async function runHashFileTick(
  db: Database,
  storage: StorageClient,
  log: Logger,
  opts: HashFileTickOpts = {},
): Promise<HashFileTickResult> {
  const batchSize =
    opts.batchSize ?? (parseInt(process.env['HASH_BATCH_SIZE'] ?? '', 10) || DEFAULT_BATCH_SIZE);
  const sizeLimit =
    opts.sizeLimitBytes ??
    (parseInt(process.env['HASH_SIZE_LIMIT_BYTES'] ?? '', 10) || DEFAULT_SIZE_LIMIT_BYTES);

  const rows = await db
    .select({
      id: files.id,
      storageKey: files.storageKey,
      sizeBytes: files.sizeBytes,
    })
    .from(files)
    .where(
      and(
        isNull(files.sha256),
        isNull(files.deletedAt),
        eq(files.pendingUpload, false),
        lt(files.sizeBytes, sizeLimit),
      ),
    )
    .orderBy(asc(files.uploadedAt))
    .limit(batchSize);

  if (rows.length === 0) {
    return { hashed: 0, failed: 0, skipped: false };
  }

  let hashed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const digest = await hashStorageObject(storage, row.storageKey);
      // Race-safe: only write if sha256 is still NULL and the row's
      // bytes haven't been swapped out from under us (etag check would
      // require an extra read; we rely on the modified_at column being
      // touched by file-level sync if etag changed, which would then
      // re-clear sha256 to NULL — see storage-sync.ts).
      await db
        .update(files)
        .set({ sha256: digest })
        .where(and(eq(files.id, row.id), isNull(files.sha256)));
      hashed += 1;
    } catch (err) {
      failed += 1;
      log.warn(
        { err, fileId: row.id, storageKey: row.storageKey },
        'hash-file: failed to hash object',
      );
    }
  }

  log.info({ hashed, failed, candidates: rows.length }, 'hash-file tick complete');
  // Silence sql import — kept for future raw-SQL diagnostics.
  void sql;
  return { hashed, failed, skipped: false };
}

async function hashStorageObject(storage: StorageClient, key: string): Promise<string> {
  const { body } = await storage.get(key);
  const hash = createHash('sha256');
  for await (const chunk of body) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
