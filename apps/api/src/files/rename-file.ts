// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0223 — the one rename primitive. Extracted from file-manage.ts so the
// manual "Rename" action and the AI naming paths share the exact same
// sanitize → join → cap → collision → copy → delete → update → audit
// sequence (which is what keeps files.storage_key mirrored on disk and
// the (firm_id, storage_key) unique index honest).

import { and, eq, isNull } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

import type { Database } from '@vibe/db';
import { files } from '@vibe/db/schema';
import {
  enforceKeyByteCap,
  joinPath,
  resolveCollision,
  sanitizeForWindows,
  type StorageClient,
} from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { loadClientFolder } from '../clients/files';
import { logger } from '../logger';

export interface RenameFileInput {
  firmId: string;
  fileId: string;
  /** Optional client scoping (the manual route has it from the URL). */
  clientId?: string;
  newFilename: string;
  actorAppUserId: string | null;
  /** Extra columns to set in the same update (AI provenance). */
  extraSet?: PgUpdateSetSource<typeof files>;
  /** Extra keys merged into the audit `after` payload. */
  extraAudit?: Record<string, unknown>;
}

export type RenameFileResult =
  | {
      ok: true;
      unchanged?: boolean;
      originalFilename: string;
      storageKey: string;
      previous: { originalFilename: string; storageKey: string };
    }
  | {
      ok: false;
      code:
        | 'file_not_found'
        | 'file_pending_upload'
        | 'client_folder_not_bound'
        | 'folder_not_active'
        | 'storage_error';
      status: number;
    };

export async function renameFile(
  db: Database,
  storage: StorageClient,
  input: RenameFileInput,
): Promise<RenameFileResult> {
  const [file] = await db
    .select({
      id: files.id,
      clientId: files.clientId,
      subfolderPath: files.subfolderPath,
      originalFilename: files.originalFilename,
      storageKey: files.storageKey,
      pendingUpload: files.pendingUpload,
    })
    .from(files)
    .where(
      and(
        eq(files.id, input.fileId),
        eq(files.firmId, input.firmId),
        ...(input.clientId ? [eq(files.clientId, input.clientId)] : []),
        isNull(files.deletedAt),
      ),
    )
    .limit(1);
  if (!file) return { ok: false, code: 'file_not_found', status: 404 };
  if (file.pendingUpload) return { ok: false, code: 'file_pending_upload', status: 409 };

  const folder = await loadClientFolder(db, input.firmId, file.clientId);
  if (!folder) return { ok: false, code: 'client_folder_not_bound', status: 404 };
  if (folder.status !== 'active') return { ok: false, code: 'folder_not_active', status: 409 };

  const safeName = sanitizeForWindows(input.newFilename);
  const previous = { originalFilename: file.originalFilename, storageKey: file.storageKey };
  if (safeName === file.originalFilename) {
    if (input.extraSet && Object.keys(input.extraSet).length) {
      await db
        .update(files)
        .set({ ...input.extraSet, modifiedAt: new Date() })
        .where(eq(files.id, file.id));
    }
    return {
      ok: true,
      unchanged: true,
      originalFilename: safeName,
      storageKey: file.storageKey,
      previous,
    };
  }

  const desired = enforceKeyByteCap(joinPath(folder.storagePath, file.subfolderPath, safeName));
  try {
    const newKey = await resolveCollision(desired, async (k) => (await storage.head(k)) !== null);
    const { etag } = await storage.copy(file.storageKey, newKey);
    await storage.delete(file.storageKey);
    await db
      .update(files)
      .set({
        ...input.extraSet,
        originalFilename: safeName,
        storageKey: newKey,
        etag,
        modifiedAt: new Date(),
      })
      .where(eq(files.id, file.id));
    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'file',
      entityId: file.id,
      actorAppUserId: input.actorAppUserId,
      before: previous,
      after: { originalFilename: safeName, storageKey: newKey, ...(input.extraAudit ?? {}) },
    }).catch(() => undefined);
    return { ok: true, originalFilename: safeName, storageKey: newKey, previous };
  } catch (err) {
    logger.error({ err, fileId: file.id }, 'file rename failed');
    return { ok: false, code: 'storage_error', status: 502 };
  }
}
