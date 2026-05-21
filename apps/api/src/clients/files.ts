// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Per-client file CRUD + download (v2 Sprint C, workstream 1.4).
// Mounted on the client router at /clients/:id/files. Multipart upload
// via express's built-in raw-body parser + busboy.

import { and, desc, eq } from 'drizzle-orm';
import { type Request, type Response, type Router } from 'express';

import type { Database } from '@vibe/db';
import { clientFiles, clients } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';
import type { StorageAdapter } from '../files/storage';

export interface FileRoutesDeps extends RbacDeps {
  db: Database | null;
  storage: StorageAdapter;
}

async function ensureClientInFirm(
  db: Database,
  clientId: string,
  firmId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

interface UploadedFile {
  fileName: string;
  mimeType: string;
  body: Buffer;
}

// Minimal multipart parser. The whole request body is buffered (we
// expect modest file sizes for CPA documents — PDFs, scans, K-1s).
// For very large files later we'd swap to busboy streaming.
async function parseMultipart(req: Request): Promise<UploadedFile | null> {
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
  const sep = buffer.indexOf(boundaryBytes);
  if (sep < 0) return null;
  const part = buffer.slice(sep + boundaryBytes.length);
  // Find the first part headers
  const headerEnd = part.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const headerText = part.slice(0, headerEnd).toString('utf8');
  const filenameMatch = /filename="([^"]+)"/.exec(headerText);
  const fileName = filenameMatch?.[1] ?? `upload-${Date.now()}`;
  const mimeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
  const mimeType = mimeMatch?.[1]?.trim() ?? 'application/octet-stream';
  const dataStart = headerEnd + 4;
  // The body ends at the next boundary marker.
  const nextBoundary = part.indexOf(boundaryBytes, dataStart);
  const dataEnd = nextBoundary < 0 ? part.length : nextBoundary - 2; // -2 strips \r\n
  const body = part.slice(dataStart, dataEnd);
  return { fileName, mimeType, body };
}

export function mountFileRoutes(router: Router, deps: FileRoutesDeps): void {
  router.get(
    '/:id/files',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
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
          engagementId: clientFiles.engagementId,
        })
        .from(clientFiles)
        .where(and(eq(clientFiles.clientId, clientId), eq(clientFiles.status, 'ACTIVE')))
        .orderBy(desc(clientFiles.uploadedAt));
      res.json({ items });
    },
  );

  router.post(
    '/:id/files',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const file = await parseMultipart(req).catch((err) => {
        logger.error({ err }, 'multipart parse failed');
        return null;
      });
      if (!file) {
        res.status(400).json({ error: 'multipart_required' });
        return;
      }
      const put = await deps.storage.put({
        firmId,
        clientId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        body: file.body,
      });
      const [row] = await deps.db
        .insert(clientFiles)
        .values({
          firmId,
          clientId,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: put.sizeBytes,
          storagePath: put.storagePath,
          uploadedById: req.staffSession!.appUserId,
        })
        .returning();
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_file',
        entityId: row?.id ?? null,
        actorAppUserId: req.staffSession!.appUserId,
        after: row ? { fileName: row.fileName, sizeBytes: row.sizeBytes } : null,
      }).catch(() => undefined);
      res.status(201).json({ file: row });
    },
  );

  router.get(
    '/:id/files/:fileId/download',
    requirePermission(deps, 'client:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(404).end();
        return;
      }
      const clientId = req.params['id']!;
      const fileId = req.params['fileId']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(clientFiles)
        .where(
          and(
            eq(clientFiles.id, fileId),
            eq(clientFiles.clientId, clientId),
            eq(clientFiles.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
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

  router.delete(
    '/:id/files/:fileId',
    requirePermission(deps, 'client:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const clientId = req.params['id']!;
      const fileId = req.params['fileId']!;
      if (!(await ensureClientInFirm(deps.db, clientId, firmId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select({ storagePath: clientFiles.storagePath, fileName: clientFiles.fileName })
        .from(clientFiles)
        .where(and(eq(clientFiles.id, fileId), eq(clientFiles.clientId, clientId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Soft-archive the row, hard-delete the blob.
      await deps.db
        .update(clientFiles)
        .set({ status: 'ARCHIVED' })
        .where(eq(clientFiles.id, fileId));
      await deps.storage.delete(row.storagePath).catch((err) => {
        logger.warn({ err, fileId }, 'storage delete failed (continuing)');
      });
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'client_file',
        entityId: fileId,
        actorAppUserId: req.staffSession!.appUserId,
        before: { fileName: row.fileName },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );
}
