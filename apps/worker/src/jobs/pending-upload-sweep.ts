// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Pending-upload janitor (Phase 8 of FILE_MANAGER_ADDENDUM.md).
//
// When the API issues a presigned PUT URL it INSERTs a `files` row with
// `pending_upload=true` so the sync worker doesn't soft-delete the
// reservation before the client actually writes the object. If the
// client never POSTs `/files/:id/complete` — they closed the browser,
// the upload failed, the URL expired — the row sits there forever.
//
// This tick scans for `pending_upload=true AND uploaded_at <
// now() - PENDING_UPLOAD_MAX_AGE_MIN` and hard-DELETEs them. We hard-
// delete rather than soft-delete because these rows represent
// reservation intent, not user-visible files; there's nothing useful
// for an admin to recover.
//
// As a belt-and-suspenders, we also try to delete the storage object
// — covers the case where the client uploaded a few bytes but never
// completed. Storage delete is idempotent so a missing object is a no-op.

import { and, eq, lt } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { files } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { incCounter } from '../metrics';

const DEFAULT_MAX_AGE_MINUTES = 30;
const DEFAULT_BATCH_SIZE = 100;

export interface PendingUploadSweepOpts {
  maxAgeMinutes?: number;
  batchSize?: number;
}

export interface PendingUploadSweepResult {
  scanned: number;
  deleted: number;
  storageErrors: number;
}

export async function runPendingUploadSweep(
  db: Database,
  storage: StorageClient,
  log: Logger,
  opts: PendingUploadSweepOpts = {},
  now = new Date(),
): Promise<PendingUploadSweepResult> {
  const maxAgeMinutes =
    opts.maxAgeMinutes ??
    (parseInt(process.env['PENDING_UPLOAD_MAX_AGE_MIN'] ?? '', 10) || DEFAULT_MAX_AGE_MINUTES);
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const cutoff = new Date(now.getTime() - maxAgeMinutes * 60_000);

  const stale = await db
    .select({
      id: files.id,
      storageKey: files.storageKey,
      uploadedAt: files.uploadedAt,
    })
    .from(files)
    .where(and(eq(files.pendingUpload, true), lt(files.uploadedAt, cutoff)))
    .limit(batchSize);

  let deleted = 0;
  let storageErrors = 0;
  for (const row of stale) {
    try {
      await storage.delete(row.storageKey);
    } catch (err) {
      storageErrors += 1;
      log.warn(
        { err, fileId: row.id, storageKey: row.storageKey },
        'pending-upload-sweep: storage delete failed; continuing with row removal',
      );
    }
    await db.delete(files).where(and(eq(files.id, row.id), eq(files.pendingUpload, true)));
    deleted += 1;
  }

  if (deleted > 0) incCounter('storage_pending_uploads_swept_total', undefined, deleted);
  log.info(
    { scanned: stale.length, deleted, storageErrors, cutoff: cutoff.toISOString() },
    'pending-upload-sweep tick complete',
  );

  return { scanned: stale.length, deleted, storageErrors };
}
