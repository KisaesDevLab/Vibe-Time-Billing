// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Stage 4 — portal-side client-request endpoints. The portal user
// fulfills (or views) requests targeting their active client.

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientRequestAttachments,
  clientRequestItems,
  clientRequests,
  engagements,
  files,
} from '@vibe/db/schema';
import { and, asc, ne, sql } from 'drizzle-orm';
import {
  buildStorageClient,
  enforceKeyByteCap,
  joinPath,
  resolveCollision,
  sanitizeForWindows,
  type StorageClient,
} from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { loadClientFolder } from '../clients/files';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

// req.portalSession augmented by portal-middleware.

const FulfillSchema = z.object({
  reason: z.string().max(500).optional(),
  messageId: z.string().uuid().nullable().optional(),
  fileId: z.string().uuid().nullable().optional(),
});

const ReplySchema = z.object({ text: z.string().min(1).max(2000) });

const AttachmentSchema = z.object({
  fileId: z.string().uuid(),
  clientRequestItemId: z.string().uuid().nullable().optional(),
});

const ItemFulfillSchema = z.object({
  fileId: z.string().uuid().nullable().optional(),
  text: z.string().max(2000).optional(),
});

export interface PortalRequestsDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: NextFunction) => unknown;
  /** 0220 — storage client for direct DOCUMENT-item uploads. When
   *  omitted, the factory is invoked with process.env. */
  storageClient?: StorageClient;
}

export function createPortalRequestsRouter(deps: PortalRequestsDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);
  router.use(deps.requireAuth);

  router.get('/', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.json({ items: [] });
      return;
    }
    // Active client's engagements → requests on them.
    const rows = await deps.db
      .select({
        id: clientRequests.id,
        engagementId: clientRequests.engagementId,
        title: clientRequests.title,
        body: clientRequests.body,
        kind: clientRequests.kind,
        status: clientRequests.status,
        dueDate: clientRequests.dueDate,
        fulfilledAt: clientRequests.fulfilledAt,
        createdAt: clientRequests.createdAt,
      })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(
        and(eq(engagements.clientId, session.activeClientId), ne(clientRequests.status, 'PENDING')),
      )
      .orderBy(desc(clientRequests.createdAt))
      .limit(200);
    res.json({ items: rows });
  });

  // 0084 — single-request detail with items + attachments + reply
  // history. Used by the new RequestDetail.tsx portal page.
  router.get('/:id', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const [request] = await deps.db
      .select()
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(
        and(
          eq(clientRequests.id, req.params['id']!),
          eq(engagements.clientId, session.activeClientId),
          ne(clientRequests.status, 'PENDING'),
        ),
      )
      .limit(1);
    if (!request) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const items = await deps.db
      .select()
      .from(clientRequestItems)
      .where(eq(clientRequestItems.clientRequestId, request.client_request.id))
      .orderBy(asc(clientRequestItems.ordinal));
    const attachments = await deps.db
      .select({
        id: clientRequestAttachments.id,
        clientRequestItemId: clientRequestAttachments.clientRequestItemId,
        fileId: clientRequestAttachments.fileId,
        uploadedAt: clientRequestAttachments.uploadedAt,
        uploadedByPortalIdentityId: clientRequestAttachments.uploadedByPortalIdentityId,
        fileName: files.originalFilename,
        fileSize: files.sizeBytes,
      })
      .from(clientRequestAttachments)
      .leftJoin(files, eq(files.id, clientRequestAttachments.fileId))
      .where(eq(clientRequestAttachments.clientRequestId, request.client_request.id))
      .orderBy(asc(clientRequestAttachments.uploadedAt));
    res.json({ request: request.client_request, items, attachments });
  });

  // 0084 — typed client reply (Q&A). Saves to client_reply_text.
  router.post('/:id/reply', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const [scoped] = await deps.db
      .select({ id: clientRequests.id })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(
        and(
          eq(clientRequests.id, req.params['id']!),
          eq(engagements.clientId, session.activeClientId),
          ne(clientRequests.status, 'PENDING'),
        ),
      )
      .limit(1);
    if (!scoped) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await deps.db
      .update(clientRequests)
      .set({ clientReplyText: parsed.data.text, clientReplySeenAt: null, updatedAt: new Date() })
      .where(eq(clientRequests.id, scoped.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'client_request',
      entityId: scoped.id,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { kind: 'portal_reply' },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  // 0084 — client flips request back to NEEDS_INFO with a typed
  // message. Staff must then PATCH/reopen.
  router.post('/:id/needs-info', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const [scoped] = await deps.db
      .select({ id: clientRequests.id })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(
        and(
          eq(clientRequests.id, req.params['id']!),
          eq(engagements.clientId, session.activeClientId),
          ne(clientRequests.status, 'PENDING'),
        ),
      )
      .limit(1);
    if (!scoped) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await deps.db
      .update(clientRequests)
      .set({
        status: 'NEEDS_INFO',
        clientReplyText: parsed.data.text,
        clientReplySeenAt: null,
        updatedAt: new Date(),
      })
      .where(eq(clientRequests.id, scoped.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'client_request',
      entityId: scoped.id,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { kind: 'portal_needs_info', status: 'NEEDS_INFO' },
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  // 0084 — record a portal file upload as an attachment to the request
  // (or one of its items). Caller must already have uploaded the file
  // via the existing portal file-manager v2 flow; this just records
  // the link.
  router.post('/:id/attachments', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = AttachmentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const [scoped] = await deps.db
      .select({ id: clientRequests.id })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(
        and(
          eq(clientRequests.id, req.params['id']!),
          eq(engagements.clientId, session.activeClientId),
          ne(clientRequests.status, 'PENDING'),
        ),
      )
      .limit(1);
    if (!scoped) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // File must belong to this client (scope guard against pasting
    // someone else's file id).
    const [file] = await deps.db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.id, parsed.data.fileId), eq(files.clientId, session.activeClientId)))
      .limit(1);
    if (!file) {
      res.status(404).json({ error: 'file_not_found' });
      return;
    }
    const [row] = await deps.db
      .insert(clientRequestAttachments)
      .values({
        clientRequestId: scoped.id,
        clientRequestItemId: parsed.data.clientRequestItemId ?? null,
        fileId: parsed.data.fileId,
        uploadedByPortalIdentityId: session.portalIdentityId,
      })
      .returning({ id: clientRequestAttachments.id });
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'client_request_attachment',
      entityId: row?.id ?? null,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: { fileId: parsed.data.fileId, itemId: parsed.data.clientRequestItemId ?? null },
    }).catch(() => undefined);
    res.status(201).json({ id: row?.id });
  });

  // 0220 — direct DOCUMENT-item upload from the portal. One call takes
  // the file bytes (base64), stores them into the client's bound folder
  // at the request's target subfolder, records the attachment, marks the
  // item FULFILLED, and rolls up the parent — no separate Files-page
  // upload + attach dance. Mounted under the 32mb body-limit override.
  const UploadSchema = z.object({
    originalFilename: z.string().min(1).max(255),
    mimeType: z.string().max(200).optional(),
    contentBase64: z.string().min(1),
  });
  const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
  router.post('/:id/items/:itemId/upload', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    // TR-5 impersonation sessions are read-only.
    if ((session as { impersonated?: boolean }).impersonated) {
      res.status(403).json({ error: 'read_only_session' });
      return;
    }
    const parsed = UploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const storage = ((): StorageClient | null => {
      if (deps.storageClient) return deps.storageClient;
      try {
        return buildStorageClient(process.env);
      } catch {
        return null;
      }
    })();
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }

    const [scoped] = await deps.db
      .select({
        id: clientRequests.id,
        status: clientRequests.status,
        targetSubfolderPath: clientRequests.targetSubfolderPath,
        firmId: clientRequests.firmId,
      })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(
        and(
          eq(clientRequests.id, req.params['id']!),
          eq(engagements.clientId, session.activeClientId),
          eq(clientRequests.firmId, session.firmId),
          ne(clientRequests.status, 'PENDING'),
        ),
      )
      .limit(1);
    if (!scoped) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (scoped.status === 'FULFILLED' || scoped.status === 'DISMISSED') {
      res.status(409).json({ error: 'request_closed' });
      return;
    }
    const [item] = await deps.db
      .select({
        id: clientRequestItems.id,
        itemKind: clientRequestItems.itemKind,
        status: clientRequestItems.status,
      })
      .from(clientRequestItems)
      .where(
        and(
          eq(clientRequestItems.id, req.params['itemId']!),
          eq(clientRequestItems.clientRequestId, scoped.id),
        ),
      )
      .limit(1);
    if (!item) {
      res.status(404).json({ error: 'item_not_found' });
      return;
    }
    if (item.itemKind !== 'DOCUMENT') {
      res.status(409).json({ error: 'not_a_document_item' });
      return;
    }

    let body: Buffer;
    try {
      body = Buffer.from(parsed.data.contentBase64, 'base64');
    } catch {
      res.status(400).json({ error: 'invalid_content_base64' });
      return;
    }
    if (body.byteLength === 0 || body.byteLength > UPLOAD_MAX_BYTES) {
      res.status(413).json({ error: 'file_too_large', max: UPLOAD_MAX_BYTES });
      return;
    }

    const folder = await loadClientFolder(deps.db, session.firmId, session.activeClientId);
    if (!folder) {
      res.status(409).json({ error: 'client_folder_not_bound' });
      return;
    }

    const subfolder = scoped.targetSubfolderPath;
    const safeFilename = sanitizeForWindows(parsed.data.originalFilename);
    const desired = enforceKeyByteCap(joinPath(folder.storagePath, subfolder, safeFilename));
    let storageKey: string;
    let etag: string;
    try {
      storageKey = await resolveCollision(desired, async (k) => (await storage.head(k)) !== null);
      const put = await storage.put(storageKey, body, {
        contentType: parsed.data.mimeType ?? 'application/octet-stream',
      });
      etag = put.etag;
    } catch (err) {
      logger.error({ err }, 'portal request-item upload failed');
      res.status(502).json({ error: 'put_failed' });
      return;
    }

    const now = new Date();
    const fileId = await deps.db.transaction(async (tx) => {
      const [fileRow] = await tx
        .insert(files)
        .values({
          firmId: session.firmId,
          clientId: session.activeClientId,
          clientFolderId: folder.clientFolderId,
          subfolderPath: subfolder,
          originalFilename: safeFilename,
          storageKey,
          mimeType: parsed.data.mimeType ?? null,
          sizeBytes: body.byteLength,
          etag,
          category: 'other',
          source: 'app',
          visibility: 'private',
          pendingUpload: false,
        })
        .returning({ id: files.id });
      const fid = fileRow!.id;
      await tx.insert(clientRequestAttachments).values({
        clientRequestId: scoped.id,
        clientRequestItemId: item.id,
        fileId: fid,
        uploadedByPortalIdentityId: session.portalIdentityId,
      });
      await tx
        .update(clientRequestItems)
        .set({
          status: 'FULFILLED',
          fulfilledAt: now,
          fulfilledByPortalIdentityId: session.portalIdentityId,
          fulfilledByFileId: fid,
          updatedAt: now,
        })
        .where(eq(clientRequestItems.id, item.id));
      // Roll-up to parent when every required item is done.
      const [remaining] = await tx
        .select({ id: clientRequestItems.id })
        .from(clientRequestItems)
        .where(
          and(
            eq(clientRequestItems.clientRequestId, scoped.id),
            eq(clientRequestItems.required, true),
            sql`${clientRequestItems.status} != 'FULFILLED'`,
          ),
        )
        .limit(1);
      if (!remaining) {
        await tx
          .update(clientRequests)
          .set({
            status: 'FULFILLED',
            fulfilledAt: now,
            fulfilledByPortalIdentityId: session.portalIdentityId,
            updatedAt: now,
          })
          .where(eq(clientRequests.id, scoped.id));
      }
      return fid;
    });

    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'file',
      entityId: fileId,
      actorPortalIdentityId: session.portalIdentityId,
      after: {
        clientId: session.activeClientId,
        storageKey,
        source: 'portal_request_upload',
        clientRequestId: scoped.id,
        clientRequestItemId: item.id,
        sizeBytes: body.byteLength,
      },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);

    res.status(201).json({ ok: true, fileId, itemId: item.id });
  });

  // 0084 — per-item fulfill from the portal. Marks the item FULFILLED
  // and rolls up the parent when every required item is done.
  router.post('/:id/items/:itemId/fulfill', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = ItemFulfillSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const [scoped] = await deps.db
      .select({ id: clientRequests.id })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(
        and(
          eq(clientRequests.id, req.params['id']!),
          eq(engagements.clientId, session.activeClientId),
          ne(clientRequests.status, 'PENDING'),
        ),
      )
      .limit(1);
    if (!scoped) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const updated = await deps.db
      .update(clientRequestItems)
      .set({
        status: 'FULFILLED',
        fulfilledAt: new Date(),
        fulfilledByPortalIdentityId: session.portalIdentityId,
        fulfilledByFileId: parsed.data.fileId ?? null,
        fulfilledText: parsed.data.text ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(clientRequestItems.id, req.params['itemId']!),
          eq(clientRequestItems.clientRequestId, scoped.id),
        ),
      )
      .returning({ id: clientRequestItems.id });
    if (updated.length === 0) {
      res.status(404).json({ error: 'item_not_found' });
      return;
    }
    // Roll-up to parent.
    const remaining = await deps.db
      .select({ id: clientRequestItems.id })
      .from(clientRequestItems)
      .where(
        and(
          eq(clientRequestItems.clientRequestId, scoped.id),
          eq(clientRequestItems.required, true),
          sql`${clientRequestItems.status} != 'FULFILLED'`,
        ),
      )
      .limit(1);
    if (remaining.length === 0) {
      await deps.db
        .update(clientRequests)
        .set({
          status: 'FULFILLED',
          fulfilledAt: new Date(),
          fulfilledByPortalIdentityId: session.portalIdentityId,
          updatedAt: new Date(),
        })
        .where(eq(clientRequests.id, scoped.id));
    }
    res.json({ ok: true });
  });

  router.post('/:id/fulfill', async (req: Request, res: Response) => {
    const session = req.portalSession;
    if (!session || !deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const parsed = FulfillSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    // Scope: caller's active client must own the request's engagement.
    const [request] = await deps.db
      .select({
        requestId: clientRequests.id,
        engagementId: clientRequests.engagementId,
        firmId: clientRequests.firmId,
        status: clientRequests.status,
        clientId: engagements.clientId,
      })
      .from(clientRequests)
      .innerJoin(engagements, eq(engagements.id, clientRequests.engagementId))
      .where(and(eq(clientRequests.id, req.params['id']!), ne(clientRequests.status, 'PENDING')))
      .limit(1);
    if (!request || request.clientId !== session.activeClientId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (request.status !== 'OPEN') {
      res.status(409).json({ error: 'wrong_status', status: request.status });
      return;
    }
    await deps.db
      .update(clientRequests)
      .set({
        status: 'FULFILLED',
        fulfilledAt: new Date(),
        fulfilledByPortalIdentityId: session.portalIdentityId,
        fulfilledByMessageId: parsed.data.messageId ?? null,
        fulfilledByFileId: parsed.data.fileId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(clientRequests.id, request.requestId));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'client_request',
      entityId: request.requestId,
      actorPortalIdentityId: session.portalIdentityId,
      activeClientId: session.activeClientId,
      after: {
        kind: 'portal_fulfill',
        messageId: parsed.data.messageId,
        fileId: parsed.data.fileId,
      },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.json({ ok: true });
  });

  return router;
}
