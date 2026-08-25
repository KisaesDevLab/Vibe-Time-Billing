// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared "put bytes into a client's File Manager folder" helper. Factored
// from POST /:id/files/generated so the intake disposition/move engine
// (Phase E) lands files exactly the way the app's own generator does:
// subfolder auto-routing, Windows-safe filename, collision resolution,
// firm visibility rules, storage.put, files row, audit.

import type { Database } from '@vibe/db';
import { files } from '@vibe/db/schema';
import {
  enforceKeyByteCap,
  joinPath,
  resolveCollision,
  sanitizeForWindows,
  type StorageClient,
} from '@vibe/storage';
import { storage as coreStorage } from '@vibe/core';

import { storageKeyTaken } from '../files/storage-key';
import { emitAudit } from '../auth/audit';
import {
  loadClientFolder,
  normalizeSubfolder,
  loadFirmVisibilityRules,
  type Category,
} from './files';
import { maybeEnqueueAutoRename } from '../files/auto-rename-queue';

export interface CreateFileArgs {
  firmId: string;
  clientId: string;
  actorId: string;
  category: Category;
  subfolderPath?: string;
  visibility?: 'private' | 'client_visible';
  originalFilename: string;
  body: Buffer;
  mimeType?: string | null;
  /** Provenance recorded on the row + audit (e.g. 'generated', 'intake'). */
  source: string;
  /**
   * 0230 — present ONLY when originalFilename IS an already-applied AI
   * name (intake-arrival label above threshold): the row carries rename
   * provenance and the auto-rename enqueue is skipped. Anything less than
   * an applied rename must NOT pass this — the file then gets the normal
   * client-bound auto-rename pass instead.
   */
  aiRename?: {
    /** The pre-rename name (e.g. the decrypted intake filename). */
    originalUploadFilename: string;
    confidence: number | null;
    model: string | null;
  };
  /**
   * 0230 — suppress the auto-rename enqueue WITHOUT rename provenance
   * (e.g. intake page images whose content is covered by the assembled
   * scan PDF's label). Decoupled from aiRename on review advice.
   */
  skipAutoRename?: boolean;
}

export type CreateFileResult =
  | {
      ok: true;
      fileId: string;
      storageKey: string;
      sizeBytes: number;
      etag: string;
      visibility: 'private' | 'client_visible';
    }
  | { ok: false; code: 'client_folder_not_bound' | 'put_failed'; detail?: string };

export async function createFileInClientFolder(
  db: Database,
  storage: StorageClient,
  args: CreateFileArgs,
): Promise<CreateFileResult> {
  const folder = await loadClientFolder(db, args.firmId, args.clientId);
  if (!folder) return { ok: false, code: 'client_folder_not_bound' };

  const subfolder = normalizeSubfolder(args.subfolderPath, args.category);
  const safeFilename = sanitizeForWindows(args.originalFilename);
  const desired = enforceKeyByteCap(joinPath(folder.storagePath, subfolder, safeFilename));
  const storageKey = await resolveCollision(desired, storageKeyTaken(db, storage, args.firmId));

  const visibilityRules = await loadFirmVisibilityRules(db, args.firmId);
  const visibility =
    args.visibility ?? coreStorage.resolveDefaultVisibility(subfolder, visibilityRules);

  let etag: string;
  try {
    const result = await storage.put(storageKey, args.body, {
      contentType: args.mimeType ?? 'application/octet-stream',
    });
    etag = result.etag;
  } catch (err) {
    return {
      ok: false,
      code: 'put_failed',
      detail: err instanceof Error ? err.message : undefined,
    };
  }

  const now = new Date();
  const [row] = await db
    .insert(files)
    .values({
      firmId: args.firmId,
      clientId: folder.clientId,
      clientFolderId: folder.clientFolderId,
      subfolderPath: subfolder,
      originalFilename: safeFilename,
      storageKey,
      mimeType: args.mimeType ?? null,
      sizeBytes: args.body.byteLength,
      etag,
      category: args.category,
      source: args.source,
      visibility,
      uploadedBy: args.actorId,
      pendingUpload: false,
      // Same shape applyAiRename produces, so the existing revert flow
      // works unchanged.
      ...(args.aiRename
        ? {
            originalUploadFilename: args.aiRename.originalUploadFilename,
            aiRenameAttemptedAt: now,
            aiRenamedAt: now,
            aiRenameConfidence: args.aiRename.confidence,
            aiRenameModel: args.aiRename.model,
          }
        : {}),
    })
    .returning({ id: files.id });

  await emitAudit(db, {
    action: 'CREATE',
    entityType: 'file',
    entityId: row?.id ?? null,
    actorAppUserId: args.actorId,
    after: {
      clientId: folder.clientId,
      storageKey,
      source: args.source,
      visibility,
      sizeBytes: args.body.byteLength,
    },
  }).catch(() => undefined);

  // 0223 — auto-rename on arrival (router mode + firm toggle; generated
  // sources are filtered inside). Fire-and-forget. Skipped when the name
  // is already an applied AI rename (0230) or the caller opted out.
  if (!args.aiRename && !args.skipAutoRename) {
    void maybeEnqueueAutoRename(db, {
      firmId: args.firmId,
      fileId: row!.id,
      actorAppUserId: args.actorId,
      source: args.source,
    });
  }

  return {
    ok: true,
    fileId: row!.id,
    storageKey,
    sizeBytes: args.body.byteLength,
    etag,
    visibility,
  };
}
