// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0219 — Files tab v3: move files, rename files, persisted subfolders,
// and folder zip download. Client-scoped like clients/files.ts (the UI
// operates inside one client's bound storage folder).
//
//   POST   /:id/subfolders          — register an (empty) subfolder
//   DELETE /:id/subfolders          — unregister an EMPTY subfolder
//   POST   /:id/files/move          — move files to another subfolder
//   POST   /:id/files/:fileId/rename — rename one file
//   GET    /:id/files/zip           — download a subfolder as a .zip
//
// Storage keys physically mirror the folder tree, so move and rename
// are B2 server-side copy → delete → row update. Single-file scale
// runs synchronously here; only whole-folder renames need the worker.

import AdmZip from 'adm-zip';
import { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, isNull, like } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientSubfolders, files, taxReturns } from '@vibe/db/schema';
import {
  buildStorageClient,
  enforceKeyByteCap,
  joinPath,
  resolveCollision,
  sanitizeForWindows,
  type StorageClient,
} from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import { loadClientFolder, normalizeSubfolder } from './files';
import { renameFile } from '../files/rename-file';

export interface FileManageDeps extends RbacDeps {
  db: Database | null;
  storageClient?: StorageClient;
}

function getStorage(deps: FileManageDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

const SubfolderSchema = z.object({
  path: z.string().min(1).max(512),
});

/** Trim stray whitespace per segment before the shared normalizer —
 *  " Income Tax/2026 " → "Income Tax/2026". */
function tidyPathInput(raw: string): string {
  return raw
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

const MoveSchema = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(200),
  toSubfolderPath: z.string().max(512), // '' = folder root
});

const RenameFileSchema = z.object({
  newFilename: z.string().min(1).max(255),
});

// In-memory zip guardrail — adm-zip buffers everything; refuse folders
// beyond this total to protect the api process. Bigger exports can use
// per-file downloads.
const ZIP_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const ZIP_MAX_FILES = 500;

/** Register a subfolder path (idempotent). Used by create + move. */
async function registerSubfolder(
  db: Database,
  firmId: string,
  clientFolderId: string,
  path: string,
  createdBy: string | null,
): Promise<void> {
  if (path === '') return;
  await db
    .insert(clientSubfolders)
    .values({ firmId, clientFolderId, path, createdBy })
    .onConflictDoNothing();
}

export function mountFileManageRoutes(router: Router, deps: FileManageDeps): void {
  // ----- POST /:id/subfolders — create/register a subfolder ------------
  router.post(
    '/:id/subfolders',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = SubfolderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const folder = await loadClientFolder(deps.db, session.firmId, req.params['id']!);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }
      const path = normalizeSubfolder(tidyPathInput(parsed.data.path), 'other');
      if (path === '') {
        res.status(400).json({ error: 'invalid_path' });
        return;
      }
      await registerSubfolder(
        deps.db,
        session.firmId,
        folder.clientFolderId,
        path,
        session.appUserId,
      );
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_subfolder',
        entityId: folder.clientFolderId,
        actorAppUserId: session.appUserId,
        after: { path },
      }).catch(() => undefined);
      res.status(201).json({ ok: true, path });
    },
  );

  // ----- DELETE /:id/subfolders — unregister an EMPTY subfolder --------
  router.delete(
    '/:id/subfolders',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = SubfolderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const folder = await loadClientFolder(deps.db, session.firmId, req.params['id']!);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }
      const path = normalizeSubfolder(tidyPathInput(parsed.data.path), 'other');
      // Refuse while any live file sits at or below the path.
      const [inUse] = await deps.db
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.clientFolderId, folder.clientFolderId),
            isNull(files.deletedAt),
            like(files.subfolderPath, `${path}%`),
          ),
        )
        .limit(1);
      if (inUse) {
        res.status(409).json({ error: 'folder_not_empty' });
        return;
      }
      await deps.db
        .delete(clientSubfolders)
        .where(
          and(
            eq(clientSubfolders.clientFolderId, folder.clientFolderId),
            like(clientSubfolders.path, `${path}%`),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_subfolder',
        entityId: folder.clientFolderId,
        actorAppUserId: session.appUserId,
        after: { path },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // ----- POST /:id/files/move — move files to another subfolder --------
  router.post(
    '/:id/files/move',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = MoveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, moved: 0 });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const folder = await loadClientFolder(deps.db, session.firmId, req.params['id']!);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }
      if (folder.status !== 'active') {
        res.status(409).json({ error: 'folder_not_active', status: folder.status });
        return;
      }
      const dest = normalizeSubfolder(parsed.data.toSubfolderPath, 'other');

      const rows = await deps.db
        .select({
          id: files.id,
          subfolderPath: files.subfolderPath,
          originalFilename: files.originalFilename,
          storageKey: files.storageKey,
          pendingUpload: files.pendingUpload,
        })
        .from(files)
        .where(
          and(
            eq(files.clientFolderId, folder.clientFolderId),
            eq(files.firmId, session.firmId),
            isNull(files.deletedAt),
          ),
        );
      const byId = new Map(rows.map((r) => [r.id, r]));

      const moved: { fileId: string; storageKey: string }[] = [];
      const skipped: { fileId: string; reason: string }[] = [];
      for (const fileId of parsed.data.fileIds) {
        const file = byId.get(fileId);
        if (!file) {
          skipped.push({ fileId, reason: 'not_found' });
          continue;
        }
        if (file.pendingUpload) {
          skipped.push({ fileId, reason: 'pending_upload' });
          continue;
        }
        if (file.subfolderPath === dest) {
          skipped.push({ fileId, reason: 'already_there' });
          continue;
        }
        const desired = enforceKeyByteCap(
          joinPath(folder.storagePath, dest, file.originalFilename),
        );
        try {
          const newKey = await resolveCollision(
            desired,
            async (k) => (await storage.head(k)) !== null,
          );
          const { etag } = await storage.copy(file.storageKey, newKey);
          await storage.delete(file.storageKey);
          await deps.db
            .update(files)
            .set({ subfolderPath: dest, storageKey: newKey, etag, modifiedAt: new Date() })
            .where(eq(files.id, file.id));
          moved.push({ fileId: file.id, storageKey: newKey });
        } catch (err) {
          logger.error({ err, fileId }, 'file move failed');
          skipped.push({ fileId, reason: 'storage_error' });
        }
      }

      // The destination folder now exists in fact; register it so it
      // survives even if these files later move away again.
      await registerSubfolder(
        deps.db,
        session.firmId,
        folder.clientFolderId,
        dest,
        session.appUserId,
      ).catch(() => undefined);

      if (moved.length > 0) {
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'file_bulk_move',
          entityId: null,
          actorAppUserId: session.appUserId,
          after: {
            count: moved.length,
            toSubfolderPath: dest,
            fileIds: moved.map((m) => m.fileId),
          },
        }).catch(() => undefined);
      }
      res.json({ ok: true, moved: moved.length, skipped });
    },
  );

  // ----- POST /:id/files/:fileId/rename — rename one file --------------
  router.post(
    '/:id/files/:fileId/rename',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = RenameFileSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      // 0223 — shared primitive with the AI naming paths.
      const result = await renameFile(deps.db, storage, {
        firmId: session.firmId,
        clientId: req.params['id']!,
        fileId: req.params['fileId']!,
        newFilename: parsed.data.newFilename,
        actorAppUserId: session.appUserId,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.code });
        return;
      }
      if (result.unchanged) {
        res.json({ ok: true, unchanged: true });
        return;
      }
      res.json({ ok: true, originalFilename: result.originalFilename });
    },
  );

  // ----- GET /:id/files/zip — download a subfolder as a .zip -----------
  // ?path=Income%20Tax%2F — trailing-slash subfolder key; '' or absent =
  // whole client folder. Always recursive; entries keep their relative
  // subfolder structure inside the archive.
  router.get(
    '/:id/files/zip',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'no_db' });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const folder = await loadClientFolder(deps.db, session.firmId, req.params['id']!);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }
      const rawPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
      const path = rawPath === '' ? '' : normalizeSubfolder(rawPath, 'other');

      const rows = await deps.db
        .select({
          id: files.id,
          subfolderPath: files.subfolderPath,
          originalFilename: files.originalFilename,
          storageKey: files.storageKey,
          sizeBytes: files.sizeBytes,
        })
        .from(files)
        .where(
          and(
            eq(files.clientFolderId, folder.clientFolderId),
            eq(files.firmId, session.firmId),
            isNull(files.deletedAt),
            eq(files.pendingUpload, false),
            ...(path === '' ? [] : [like(files.subfolderPath, `${path}%`)]),
          ),
        )
        .orderBy(asc(files.subfolderPath), asc(files.originalFilename));

      if (rows.length === 0) {
        res.status(404).json({ error: 'no_files' });
        return;
      }
      if (rows.length > ZIP_MAX_FILES) {
        res.status(413).json({ error: 'too_many_files', count: rows.length, max: ZIP_MAX_FILES });
        return;
      }
      const totalBytes = rows.reduce((acc, r) => acc + Number(r.sizeBytes), 0);
      if (totalBytes > ZIP_MAX_TOTAL_BYTES) {
        res.status(413).json({ error: 'folder_too_large', totalBytes, max: ZIP_MAX_TOTAL_BYTES });
        return;
      }

      const zip = new AdmZip();
      for (const row of rows) {
        try {
          const { body } = await storage.get(row.storageKey);
          const chunks: Buffer[] = [];
          for await (const chunk of body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          // Entry path relative to the requested folder, preserving the
          // deeper structure ("2025/W-2.pdf" inside an "Income Tax" zip).
          const rel = path === '' ? row.subfolderPath : row.subfolderPath.slice(path.length);
          zip.addFile(`${rel}${row.originalFilename}`, Buffer.concat(chunks));
        } catch (err) {
          logger.warn({ err, fileId: row.id }, 'zip: skipping unreadable object');
        }
      }

      const folderLabel =
        path === ''
          ? (folder.storagePath.replace(/\/+$/, '').split('/').pop() ?? 'files')
          : (path.replace(/\/+$/, '').split('/').pop() ?? 'files');
      const filename = `${sanitizeForWindows(folderLabel)}.zip`;

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_folder',
        entityId: folder.clientFolderId,
        actorAppUserId: session.appUserId,
        after: { op: 'zip_download', path, count: rows.length },
      }).catch(() => undefined);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(zip.toBuffer());
    },
  );
}

/** True when any live tax return references this file as its source —
 *  used by the DELETE guard so a filed return's PDF can't be casually
 *  destroyed. */
export async function fileBacksTaxReturn(db: Database, fileId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: taxReturns.id })
    .from(taxReturns)
    .where(eq(taxReturns.sourceFileId, fileId))
    .limit(1);
  return Boolean(row);
}
