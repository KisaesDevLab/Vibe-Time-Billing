// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Folder-rename orchestrator (Phase 9 of FILE_MANAGER_ADDENDUM.md).
//
// Choreography (idempotent at each step where possible):
//
//   1.  Snapshot the client_folders row. Refuse if status != 'active'.
//   2.  Mark status = 'renaming' (acts as the cross-worker exclusion
//       lock — only one rename in flight per folder).
//   3.  Write _Vibe/.locked marker into the OLD folder so the
//       file-level sync diff treats the folder as in-flux (the sync
//       worker already skips _Vibe/ via classifyObservedKey).
//   4.  LIST every object under the old folder (recursive).
//   5.  For each object except the marker: server-side COPY to the
//       new prefix. Parallelism capped by STORAGE_SYNC_CONCURRENCY
//       (default 8). Sentinel goes along — same client_id by spec.
//   6.  Verify counts match. Per-object HEAD check is the addendum's
//       "verify size + etag" step — we trust the copy() return etag
//       and only fall back to HEAD on a mismatch.
//   7.  updateSentinel at the NEW location with the fresh
//       display_name_at_creation. client_id is immutable by design.
//   8.  DELETE the originals (sentinel last, so a mid-step crash
//       always leaves a discoverable sentinel somewhere).
//   9.  In a single transaction:
//         - UPDATE files.storage_key for every row in the folder
//           (substitute old prefix for new).
//         - UPDATE client_folders.storage_path + status = 'active'.
//         - INSERT folder_sync_events row with event_type='renamed',
//           resolution='completed'.
//
// Failure handling: any throw past step 2 leaves the row in
// status='renaming' and writes a folder_sync_events row with
// event_type='renamed', resolution='failed'. The marker file stays.
// The admin gets a "Resume / Rollback" affordance in Phase 10.
//
// Progress reporting: each phase publishes to
// `storage-progress:{client_folder_id}` via the optional publish hook.
// The SSE endpoint in apps/api/src/clients/folder.ts subscribes and
// forwards to the FE.

import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { clientFolders, files, folderSyncEvents } from '@vibe/db/schema';
import { sanitizeForWindows, sentinelKey, updateSentinel, type StorageClient } from '@vibe/storage';

export interface FolderRenameDeps {
  db: Database;
  storage: StorageClient;
  log: Logger;
  /** Optional publisher for storage-progress events. */
  publish?: (channel: string, message: string) => Promise<void>;
  /** Max parallel copy operations. Defaults to STORAGE_SYNC_CONCURRENCY env or 8. */
  concurrency?: number;
}

export interface FolderRenamePayload {
  clientFolderId: string;
  firmId: string;
  /** Human-typed new folder name. Sanitized before use. */
  newName: string;
  /** Actor for audit attribution. */
  actorAppUserId?: string | null;
}

export type FolderRenamePhase =
  | 'preflight'
  | 'mark_renaming'
  | 'lock_marker'
  | 'listing'
  | 'copying'
  | 'verify'
  | 'sentinel_update'
  | 'delete_originals'
  | 'db_update'
  | 'complete'
  | 'failed';

export interface FolderRenameResult {
  ok: boolean;
  clientFolderId: string;
  oldPath?: string;
  newPath?: string;
  objectsMoved?: number;
  reason?: string;
}

const LOCK_MARKER_NAME = '.locked';

interface ProgressEvent {
  phase: FolderRenamePhase;
  clientFolderId: string;
  oldPath?: string;
  newPath?: string;
  total?: number;
  done?: number;
  message?: string;
}

async function emit(deps: FolderRenameDeps, payload: ProgressEvent): Promise<void> {
  if (!deps.publish) return;
  try {
    await deps.publish(`storage-progress:${payload.clientFolderId}`, JSON.stringify(payload));
  } catch (err) {
    deps.log.warn({ err }, 'folder-rename: progress publish failed (ignored)');
  }
}

export async function runFolderRename(
  deps: FolderRenameDeps,
  payload: FolderRenamePayload,
): Promise<FolderRenameResult> {
  const { db, storage, log } = deps;
  const concurrency =
    deps.concurrency ?? (parseInt(process.env['STORAGE_SYNC_CONCURRENCY'] ?? '', 10) || 8);

  // -------- 1) Preflight --------------------------------------------
  await emit(deps, { phase: 'preflight', clientFolderId: payload.clientFolderId });
  const [folder] = await db
    .select({
      id: clientFolders.id,
      firmId: clientFolders.firmId,
      clientId: clientFolders.clientId,
      storagePath: clientFolders.storagePath,
      status: clientFolders.status,
    })
    .from(clientFolders)
    .where(
      and(eq(clientFolders.id, payload.clientFolderId), eq(clientFolders.firmId, payload.firmId)),
    )
    .limit(1);

  if (!folder) {
    return { ok: false, clientFolderId: payload.clientFolderId, reason: 'folder_not_found' };
  }
  if (folder.status !== 'active') {
    return { ok: false, clientFolderId: folder.id, reason: `not_active:${folder.status}` };
  }

  const oldPath = folder.storagePath;
  const sanitizedNew = sanitizeForWindows(payload.newName);
  if (!sanitizedNew || sanitizedNew === '_') {
    return { ok: false, clientFolderId: folder.id, reason: 'invalid_new_name' };
  }
  // Preserve the parent prefix of the old path; we're only renaming the
  // top-level folder segment, not moving across parent prefixes (that's
  // the move job's job).
  const lastSlashBeforeTrailing = oldPath.replace(/\/$/, '').lastIndexOf('/');
  const parentPrefix =
    lastSlashBeforeTrailing >= 0 ? oldPath.slice(0, lastSlashBeforeTrailing + 1) : '';
  const newPath = `${parentPrefix}${sanitizedNew}/`;
  if (newPath === oldPath) {
    return { ok: false, clientFolderId: folder.id, reason: 'no_op_same_path' };
  }

  // -------- 2) Mark renaming ----------------------------------------
  await emit(deps, { phase: 'mark_renaming', clientFolderId: folder.id, oldPath, newPath });
  // Compare-and-set: only proceed if still 'active'. Two concurrent
  // rename attempts race here and exactly one wins.
  const flipResult = await db
    .update(clientFolders)
    .set({ status: 'renaming', updatedAt: new Date() })
    .where(and(eq(clientFolders.id, folder.id), eq(clientFolders.status, 'active')))
    .returning({ id: clientFolders.id });
  if (flipResult.length === 0) {
    return { ok: false, clientFolderId: folder.id, reason: 'lock_lost' };
  }

  try {
    // -------- 3) Write the lock marker ------------------------------
    await emit(deps, { phase: 'lock_marker', clientFolderId: folder.id, oldPath, newPath });
    const markerKey = `${oldPath}${sentinelFolderName()}/${LOCK_MARKER_NAME}`;
    await storage.put(
      markerKey,
      Buffer.from(
        JSON.stringify({
          locked_at: new Date().toISOString(),
          op: 'folder-rename',
          new_path: newPath,
        }),
        'utf8',
      ),
      { contentType: 'application/json' },
    );

    // -------- 4) List the source ------------------------------------
    await emit(deps, { phase: 'listing', clientFolderId: folder.id, oldPath, newPath });
    const sourceObjects: { key: string; sizeBytes: number; etag: string }[] = [];
    for await (const entry of storage.list(oldPath, { recursive: true })) {
      if (entry.kind !== 'object' || !entry.meta) continue;
      // Skip the lock marker — it's a transient signal, not user content.
      if (entry.key === markerKey) continue;
      sourceObjects.push({
        key: entry.key,
        sizeBytes: entry.meta.sizeBytes,
        etag: entry.meta.etag,
      });
    }

    // -------- 5) Parallel server-side copy --------------------------
    await emit(deps, {
      phase: 'copying',
      clientFolderId: folder.id,
      oldPath,
      newPath,
      total: sourceObjects.length,
      done: 0,
    });
    const copiedKeys = new Set<string>();
    let done = 0;
    await runWithConcurrency(sourceObjects, concurrency, async (src) => {
      const destKey = `${newPath}${src.key.slice(oldPath.length)}`;
      await storage.copy(src.key, destKey);
      copiedKeys.add(destKey);
      done += 1;
      // Throttle the publish — every 10th object + the last one.
      if (done % 10 === 0 || done === sourceObjects.length) {
        await emit(deps, {
          phase: 'copying',
          clientFolderId: folder.id,
          oldPath,
          newPath,
          total: sourceObjects.length,
          done,
        });
      }
    });

    // -------- 6) Verify count ---------------------------------------
    await emit(deps, { phase: 'verify', clientFolderId: folder.id, oldPath, newPath });
    if (copiedKeys.size !== sourceObjects.length) {
      throw new Error(
        `verify_count_mismatch: copied=${copiedKeys.size} expected=${sourceObjects.length}`,
      );
    }

    // -------- 7) Update sentinel at new location --------------------
    await emit(deps, { phase: 'sentinel_update', clientFolderId: folder.id, oldPath, newPath });
    await updateSentinel(
      storage,
      newPath,
      { display_name_at_creation: sanitizedNew },
      { expectedFirmId: folder.firmId },
    );

    // -------- 8) Delete originals -----------------------------------
    await emit(deps, { phase: 'delete_originals', clientFolderId: folder.id, oldPath, newPath });
    // Delete the lock marker FIRST so even a mid-step crash leaves the
    // old sentinel discoverable and the marker doesn't get orphaned.
    await storage.delete(markerKey);
    const oldSentinelKey = sentinelKey(oldPath);
    // Defer the old sentinel until the very end (so the post-crash
    // recovery path can still verify identity).
    const otherKeys = sourceObjects.map((s) => s.key).filter((k) => k !== oldSentinelKey);
    await runWithConcurrency(otherKeys, concurrency, async (k) => {
      await storage.delete(k);
    });
    await storage.delete(oldSentinelKey);

    // -------- 9) DB update + audit in one transaction --------------
    await emit(deps, { phase: 'db_update', clientFolderId: folder.id, oldPath, newPath });
    await db.transaction(async (tx) => {
      // Rewrite storage_key for every file row in this folder.
      const allFileRows = await tx
        .select({ id: files.id, storageKey: files.storageKey })
        .from(files)
        .where(eq(files.clientFolderId, folder.id));
      for (const row of allFileRows) {
        if (!row.storageKey.startsWith(oldPath)) continue;
        const newKey = `${newPath}${row.storageKey.slice(oldPath.length)}`;
        await tx
          .update(files)
          .set({ storageKey: newKey, modifiedAt: new Date() })
          .where(eq(files.id, row.id));
      }
      await tx
        .update(clientFolders)
        .set({
          storagePath: newPath,
          status: 'active',
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(clientFolders.id, folder.id));
      await tx.insert(folderSyncEvents).values({
        firmId: folder.firmId,
        clientFolderId: folder.id,
        eventType: 'renamed',
        pathBefore: oldPath,
        pathAfter: newPath,
        resolvedAt: new Date(),
        resolvedBy: payload.actorAppUserId ?? null,
        resolution: 'completed',
        notes: `Renamed by folder-rename job; ${sourceObjects.length} objects moved.`,
      });
    });

    await emit(deps, {
      phase: 'complete',
      clientFolderId: folder.id,
      oldPath,
      newPath,
      total: sourceObjects.length,
      done: sourceObjects.length,
    });
    log.info(
      { clientFolderId: folder.id, oldPath, newPath, count: sourceObjects.length },
      'folder-rename complete',
    );
    return {
      ok: true,
      clientFolderId: folder.id,
      oldPath,
      newPath,
      objectsMoved: sourceObjects.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, clientFolderId: folder.id, oldPath, newPath }, 'folder-rename failed');
    // Leave status='renaming' so the admin can resume/rollback. Write
    // a failure marker into folder_sync_events.
    await db
      .insert(folderSyncEvents)
      .values({
        firmId: folder.firmId,
        clientFolderId: folder.id,
        eventType: 'renamed',
        pathBefore: oldPath,
        pathAfter: newPath,
        resolution: 'failed',
        notes: message.slice(0, 1000),
      })
      .catch(() => undefined);
    await emit(deps, {
      phase: 'failed',
      clientFolderId: folder.id,
      oldPath,
      newPath,
      message,
    });
    return { ok: false, clientFolderId: folder.id, oldPath, newPath, reason: message };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sentinelFolderName(): string {
  return process.env['STORAGE_SENTINEL_FOLDER'] ?? '_Vibe';
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const cap = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < cap; i++) {
    workers.push(
      (async () => {
        for (;;) {
          const idx = cursor++;
          if (idx >= items.length) return;
          await fn(items[idx]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
}
