// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Internal (firm-scoped, no-client) file CRUD. Mirrors the per-client
// file API but writes rows with client_id=NULL + is_internal=true so
// they surface in the /files "Internal files" tab.
//
// Storage path uses "_internal" as the client placeholder so we can
// keep the existing StorageAdapter.put signature unchanged.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientFiles, clientFolders } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import type { StorageAdapter } from '../files/storage';

export interface InternalFileRoutesDeps extends RbacDeps {
  db: Database | null;
  storage: StorageAdapter;
}

interface UploadedFile {
  fileName: string;
  mimeType: string;
  body: Buffer;
}

interface ParsedMultipart {
  file: UploadedFile | null;
  fields: Record<string, string>;
}

async function parseMultipart(req: Request): Promise<ParsedMultipart | null> {
  const contentType = req.header('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) return null;
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);

  const boundaryBytes = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const next = buffer.indexOf(boundaryBytes, cursor);
    if (next < 0) break;
    if (next > cursor) parts.push(buffer.slice(cursor, next));
    cursor = next + boundaryBytes.length;
  }

  let file: UploadedFile | null = null;
  const fields: Record<string, string> = {};
  for (const raw of parts) {
    let part = raw;
    if (part.length >= 2 && part[0] === 0x0d && part[1] === 0x0a) part = part.slice(2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const dispositionMatch = /Content-Disposition:\s*([^\r\n]+)/i.exec(headerText);
    if (!dispositionMatch) continue;
    const disposition = dispositionMatch[1] ?? '';
    const nameMatch = /name="([^"]+)"/.exec(disposition);
    const fileNameMatch = /filename="([^"]+)"/.exec(disposition);
    const name = nameMatch?.[1];
    if (!name) continue;
    const dataStart = headerEnd + 4;
    let dataEnd = part.length;
    if (dataEnd >= 2 && part[dataEnd - 2] === 0x0d && part[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const body = part.slice(dataStart, dataEnd);
    if (fileNameMatch) {
      const mimeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      file = {
        fileName: fileNameMatch[1] ?? `upload-${Date.now()}`,
        mimeType: mimeMatch?.[1]?.trim() ?? 'application/octet-stream',
        body,
      };
    } else {
      fields[name] = body.toString('utf8');
    }
  }
  return { file, fields };
}

export function createInternalFileRouter(deps: InternalFileRoutesDeps): Router {
  const router = express.Router();

  router.get('/', requirePermission(deps, 'client:read'), async (req: Request, res: Response) => {
    const firmId = req.staffSession?.firmId;
    if (!firmId || !deps.db) {
      res.json({ items: [] });
      return;
    }
    const folderFilter = typeof req.query['folderId'] === 'string' ? req.query['folderId'] : null;
    const conds = [
      eq(clientFiles.firmId, firmId),
      eq(clientFiles.isInternal, true),
      eq(clientFiles.status, 'ACTIVE'),
    ];
    if (folderFilter === 'root') {
      conds.push(isNull(clientFiles.folderId));
    } else if (folderFilter) {
      conds.push(eq(clientFiles.folderId, folderFilter));
    }
    const items = await deps.db
      .select({
        id: clientFiles.id,
        fileName: clientFiles.fileName,
        mimeType: clientFiles.mimeType,
        sizeBytes: clientFiles.sizeBytes,
        uploadedById: clientFiles.uploadedById,
        uploadedAt: clientFiles.uploadedAt,
        status: clientFiles.status,
        folderId: clientFiles.folderId,
        externalUrl: clientFiles.externalUrl,
        visibleInPortal: clientFiles.visibleInPortal,
        isInbox: clientFiles.isInbox,
      })
      .from(clientFiles)
      .where(and(...conds))
      .orderBy(desc(clientFiles.uploadedAt));
    res.json({ items });
  });

  router.post('/', requirePermission(deps, 'client:write'), async (req: Request, res: Response) => {
    const firmId = req.staffSession!.firmId;
    if (!deps.db) {
      res.json({ ok: true });
      return;
    }
    const parsed = await parseMultipart(req).catch((err) => {
      logger.error({ err }, 'multipart parse failed');
      return null;
    });
    if (!parsed || !parsed.file) {
      res.status(400).json({ error: 'multipart_required' });
      return;
    }
    const file = parsed.file;
    const folderIdRaw = parsed.fields['folderId'];
    const folderId = folderIdRaw && folderIdRaw !== 'root' ? folderIdRaw : null;
    const put = await deps.storage.put({
      firmId,
      clientId: '_internal',
      fileName: file.fileName,
      mimeType: file.mimeType,
      body: file.body,
    });
    const [row] = await deps.db
      .insert(clientFiles)
      .values({
        firmId,
        clientId: null,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: put.sizeBytes,
        storagePath: put.storagePath,
        folderId,
        isInbox: false,
        isInternal: true,
        uploadedById: req.staffSession!.appUserId,
      })
      .returning();
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'client_file',
      entityId: row?.id ?? null,
      actorAppUserId: req.staffSession!.appUserId,
      after: row
        ? { fileName: row.fileName, sizeBytes: row.sizeBytes, folderId, kind: 'internal' }
        : null,
    }).catch(() => undefined);
    res.status(201).json({ file: row });
  });

  router.post(
    '/upload-link',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = (req.body ?? {}) as {
        fileName?: string;
        externalUrl?: string;
        folderId?: string | null;
      };
      const fileName = typeof body.fileName === 'string' ? body.fileName.slice(0, 300).trim() : '';
      const externalUrl =
        typeof body.externalUrl === 'string' ? body.externalUrl.slice(0, 2000).trim() : '';
      if (!fileName || !externalUrl) {
        res.status(400).json({ error: 'fileName_and_externalUrl_required' });
        return;
      }
      if (!/^https?:\/\//i.test(externalUrl)) {
        res.status(400).json({ error: 'externalUrl_must_be_http' });
        return;
      }
      const folderId = body.folderId && body.folderId !== 'root' ? body.folderId : null;
      const [row] = await deps.db
        .insert(clientFiles)
        .values({
          firmId,
          clientId: null,
          fileName,
          mimeType: 'application/x-external-link',
          sizeBytes: 0,
          storagePath: null,
          externalUrl,
          folderId,
          isInbox: false,
          isInternal: true,
          uploadedById: req.staffSession!.appUserId,
        })
        .returning();
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_file',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { fileName, externalUrl, folderId, kind: 'internal_link' },
      }).catch(() => undefined);
      res.status(201).json({ file: row });
    },
  );

  router.get(
    '/:fileId/download',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(404).end();
        return;
      }
      const fileId = req.params['fileId']!;
      const [row] = await deps.db
        .select()
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.id, fileId),
            eq(clientFiles.firmId, firmId),
            eq(clientFiles.isInternal, true),
            eq(clientFiles.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!row.storagePath && row.externalUrl) {
        res.json({ kind: 'external', url: row.externalUrl, fileName: row.fileName });
        return;
      }
      if (!row.storagePath) {
        res.status(500).json({ error: 'missing_storage_path' });
        return;
      }
      try {
        const { stream } = await deps.storage.get(row.storagePath);
        res.setHeader('Content-Type', row.mimeType);
        res.setHeader('Content-Length', String(row.sizeBytes));
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${row.fileName.replace(/"/g, "'")}"`,
        );
        stream.pipe(res);
      } catch (err) {
        logger.error({ err, fileId }, 'storage read failed');
        res.status(500).json({ error: 'storage_read_failed' });
      }
    },
  );

  router.post(
    '/:fileId/move',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const fileId = req.params['fileId']!;
      const body = (req.body ?? {}) as { folderId?: string | null };
      const folderId = typeof body.folderId === 'string' && body.folderId ? body.folderId : null;
      await deps.db
        .update(clientFiles)
        .set({ folderId })
        .where(
          and(
            eq(clientFiles.id, fileId),
            eq(clientFiles.firmId, firmId),
            eq(clientFiles.isInternal, true),
          ),
        );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_file',
        entityId: fileId,
        actorAppUserId: req.staffSession!.appUserId,
        after: { folderId, kind: 'internal_move' },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.post(
    '/bulk-move',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true, updated: 0 });
        return;
      }
      const body = (req.body ?? {}) as { fileIds?: unknown; folderId?: string | null };
      const ids = Array.isArray(body.fileIds)
        ? body.fileIds.filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'fileIds_required' });
        return;
      }
      const folderId = typeof body.folderId === 'string' && body.folderId ? body.folderId : null;
      const updated = await deps.db
        .update(clientFiles)
        .set({ folderId })
        .where(
          and(
            eq(clientFiles.firmId, firmId),
            eq(clientFiles.isInternal, true),
            inArray(clientFiles.id, ids),
          ),
        )
        .returning({ id: clientFiles.id });
      for (const r of updated) {
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'client_file',
          entityId: r.id,
          actorAppUserId: req.staffSession!.appUserId,
          after: { folderId, kind: 'internal_bulk_move' },
        }).catch(() => undefined);
      }
      res.json({ ok: true, updated: updated.length });
    },
  );

  router.post(
    '/bulk-delete',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = (req.body ?? {}) as { fileIds?: unknown };
      const ids = Array.isArray(body.fileIds)
        ? body.fileIds.filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'fileIds_required' });
        return;
      }
      const rows = await deps.db
        .select({ id: clientFiles.id, storagePath: clientFiles.storagePath })
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.firmId, firmId),
            eq(clientFiles.isInternal, true),
            inArray(clientFiles.id, ids),
          ),
        );
      await deps.db
        .update(clientFiles)
        .set({ status: 'ARCHIVED' })
        .where(
          and(
            eq(clientFiles.firmId, firmId),
            eq(clientFiles.isInternal, true),
            inArray(clientFiles.id, ids),
          ),
        );
      for (const r of rows) {
        if (r.storagePath) {
          await deps.storage.delete(r.storagePath).catch((err) => {
            logger.warn({ err, fileId: r.id }, 'storage delete failed (continuing)');
          });
        }
        await emitAudit(deps.db, {
          action: 'ARCHIVE',
          entityType: 'client_file',
          entityId: r.id,
          actorAppUserId: req.staffSession!.appUserId,
          after: { kind: 'internal_bulk_delete' },
        }).catch(() => undefined);
      }
      res.json({ ok: true, archived: rows.length });
    },
  );

  router.delete(
    '/:fileId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const fileId = req.params['fileId']!;
      const [row] = await deps.db
        .select({ storagePath: clientFiles.storagePath, fileName: clientFiles.fileName })
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.id, fileId),
            eq(clientFiles.firmId, firmId),
            eq(clientFiles.isInternal, true),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(clientFiles)
        .set({ status: 'ARCHIVED' })
        .where(eq(clientFiles.id, fileId));
      if (row.storagePath) {
        await deps.storage.delete(row.storagePath).catch((err) => {
          logger.warn({ err, fileId }, 'storage delete failed (continuing)');
        });
      }
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_file',
        entityId: fileId,
        actorAppUserId: req.staffSession!.appUserId,
        before: { fileName: row.fileName, kind: 'internal' },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // v2 Part 1 — internal-scoped folder CRUD. Mirrors the per-client
  // folder API but with client_id=NULL + is_internal=true.
  router.get(
    '/folders/list',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(clientFolders)
        .where(and(eq(clientFolders.firmId, firmId), eq(clientFolders.isInternal, true)));
      res.json({ items });
    },
  );

  router.post(
    '/folders',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = (req.body ?? {}) as { name?: string; parentFolderId?: string | null };
      const name = typeof body.name === 'string' ? body.name.slice(0, 200).trim() : '';
      if (!name) {
        res.status(400).json({ error: 'name_required' });
        return;
      }
      const [row] = await deps.db
        .insert(clientFolders)
        .values({
          firmId,
          clientId: null,
          parentFolderId: body.parentFolderId ?? null,
          name,
          isInternal: true,
          createdById: req.staffSession!.appUserId,
        })
        .returning({ id: clientFolders.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_folder',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: { name, kind: 'internal_folder' },
      }).catch(() => undefined);
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/folders/:folderId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const folderId = req.params['folderId']!;
      const body = (req.body ?? {}) as { name?: string; parentFolderId?: string | null };
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (typeof body.name === 'string') updates.name = body.name.slice(0, 200).trim();
      if (body.parentFolderId !== undefined) updates.parentFolderId = body.parentFolderId ?? null;
      await deps.db
        .update(clientFolders)
        .set(updates)
        .where(
          and(
            eq(clientFolders.id, folderId),
            eq(clientFolders.firmId, firmId),
            eq(clientFolders.isInternal, true),
          ),
        );
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_folder',
        entityId: folderId,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  router.delete(
    '/folders/:folderId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const folderId = req.params['folderId']!;
      const [fileCount] = await deps.db
        .select({ id: clientFiles.id })
        .from(clientFiles)
        .where(and(eq(clientFiles.folderId, folderId), eq(clientFiles.status, 'ACTIVE')))
        .limit(1);
      const [childCount] = await deps.db
        .select({ id: clientFolders.id })
        .from(clientFolders)
        .where(eq(clientFolders.parentFolderId, folderId))
        .limit(1);
      if (fileCount || childCount) {
        res.status(409).json({ error: 'not_empty' });
        return;
      }
      await deps.db
        .delete(clientFolders)
        .where(
          and(
            eq(clientFolders.id, folderId),
            eq(clientFolders.firmId, firmId),
            eq(clientFolders.isInternal, true),
          ),
        );
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_folder',
        entityId: folderId,
        actorAppUserId: req.staffSession!.appUserId,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}
