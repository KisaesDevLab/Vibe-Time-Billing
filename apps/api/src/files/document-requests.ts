// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0219 — document requests. Staff ask a client for a list of documents;
// the client uploads against each item from the portal without staff
// chasing attachments over email.
//
// Staff (mounted /api/staff/document-requests):
//   POST   /            — create a request (title, items, target folder)
//                         + optionally email the billing contact
//   GET    /?clientId=  — list a client's requests with item status
//   PATCH  /:id         — complete / cancel / reopen
//
// Portal (mounted /api/portal/document-requests):
//   GET    /            — the active client's OPEN requests + items
//   POST   /items/:itemId/upload — upload one document against an item
//                         (base64 body; server-side PUT into the client's
//                         bound folder at the request's target subfolder)
//
// Portal uploads land private (staff review before anything becomes
// client-visible elsewhere) with source='app' and the uploader's
// portal_identity recorded in the audit row per CLAUDE.md non-negotiable
// #4 actor rules.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, documentRequestItems, documentRequests, files, firms } from '@vibe/db/schema';
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
import { getBillingContact } from '../clients/billing-contact';
import { loadClientFolder, normalizeSubfolder } from '../clients/files';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Staff router
// ---------------------------------------------------------------------------

export interface DocumentRequestStaffDeps extends RbacDeps {
  db: Database | null;
  sendStaffMail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  portalBaseUrl?: string;
}

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
  targetSubfolderPath: z.string().max(512).optional(),
  items: z.array(z.string().min(1).max(300)).min(1).max(50),
  /** Email the billing contact a heads-up with a portal link. */
  notifyClient: z.boolean().optional(),
});

const PatchSchema = z.object({
  status: z.enum(['OPEN', 'COMPLETED', 'CANCELLED']),
});

export function createDocumentRequestStaffRouter(deps: DocumentRequestStaffDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.post(
    '/',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const target = normalizeSubfolder(parsed.data.targetSubfolderPath, 'other');
      const [row] = await deps.db
        .insert(documentRequests)
        .values({
          firmId: session.firmId,
          clientId: client.id,
          title: parsed.data.title.trim(),
          note: parsed.data.note?.trim() || null,
          targetSubfolderPath: target,
          status: 'OPEN',
          createdBy: session.appUserId,
        })
        .returning({ id: documentRequests.id });
      const requestId = row!.id;
      await deps.db.insert(documentRequestItems).values(
        parsed.data.items.map((label) => ({
          requestId,
          label: label.trim(),
        })),
      );

      let notified: string | null = null;
      if (parsed.data.notifyClient && deps.sendStaffMail && deps.portalBaseUrl) {
        const contact = await getBillingContact(deps.db, client.id);
        if (contact?.email) {
          const [firm] = await deps.db
            .select({ name: firms.name })
            .from(firms)
            .where(eq(firms.id, session.firmId))
            .limit(1);
          const firmName = firm?.name ?? 'Your accounting firm';
          const url = `${deps.portalBaseUrl.replace(/\/$/, '')}/files`;
          try {
            await deps.sendStaffMail({
              to: contact.email,
              subject: `${firmName} — documents requested: ${parsed.data.title.trim()}`,
              body: [
                `Hi ${contact.fullName},`,
                '',
                `${firmName} is requesting the following documents:`,
                ...parsed.data.items.map((i) => `  • ${i}`),
                ...(parsed.data.note?.trim() ? ['', parsed.data.note.trim()] : []),
                '',
                'Please sign in to your client portal and upload them under Files:',
                url,
                '',
                'Thank you!',
              ].join('\n'),
            });
            notified = contact.email;
          } catch (err) {
            logger.error({ err }, 'document request notify failed');
          }
        }
      }

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'document_request',
        entityId: requestId,
        actorAppUserId: session.appUserId,
        after: {
          clientId: client.id,
          title: parsed.data.title.trim(),
          items: parsed.data.items.length,
          notified,
        },
      }).catch(() => undefined);
      res.status(201).json({ ok: true, requestId, notified });
    },
  );

  router.get(
    '/',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientId = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : '';
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
        res.status(400).json({ error: 'invalid_client_id' });
        return;
      }
      const requests = await deps.db
        .select()
        .from(documentRequests)
        .where(
          and(eq(documentRequests.clientId, clientId), eq(documentRequests.firmId, session.firmId)),
        )
        .orderBy(desc(documentRequests.createdAt));
      const ids = requests.map((r) => r.id);
      const items = ids.length
        ? await deps.db
            .select()
            .from(documentRequestItems)
            .where(inArray(documentRequestItems.requestId, ids))
        : [];
      res.json({
        items: requests.map((r) => ({
          ...r,
          items: items.filter((i) => i.requestId === r.id),
        })),
      });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .update(documentRequests)
        .set({ status: parsed.data.status, updatedAt: new Date() })
        .where(
          and(
            eq(documentRequests.id, req.params['id']!),
            eq(documentRequests.firmId, session.firmId),
          ),
        )
        .returning({ id: documentRequests.id });
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'document_request',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { status: parsed.data.status },
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  return router;
}

// ---------------------------------------------------------------------------
// Portal router
// ---------------------------------------------------------------------------

export interface DocumentRequestPortalDeps {
  db: Database | null;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  storageClient?: StorageClient;
}

// Base64 expands ~4/3, and the route's express.json limit is 32mb —
// keep the decoded cap safely under that.
const PORTAL_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

const PortalUploadSchema = z.object({
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().max(200).optional(),
  contentBase64: z.string().min(1),
});

function getStorage(deps: DocumentRequestPortalDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

export function createDocumentRequestPortalRouter(deps: DocumentRequestPortalDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const requests = await deps.db
      .select({
        id: documentRequests.id,
        title: documentRequests.title,
        note: documentRequests.note,
        createdAt: documentRequests.createdAt,
      })
      .from(documentRequests)
      .where(
        and(
          eq(documentRequests.clientId, session.activeClientId),
          eq(documentRequests.firmId, session.firmId),
          eq(documentRequests.status, 'OPEN'),
        ),
      )
      .orderBy(desc(documentRequests.createdAt));
    const ids = requests.map((r) => r.id);
    const items = ids.length
      ? await deps.db
          .select({
            id: documentRequestItems.id,
            requestId: documentRequestItems.requestId,
            label: documentRequestItems.label,
            status: documentRequestItems.status,
            uploadedAt: documentRequestItems.uploadedAt,
          })
          .from(documentRequestItems)
          .where(inArray(documentRequestItems.requestId, ids))
      : [];
    res.json({
      items: requests.map((r) => ({
        ...r,
        items: items.filter((i) => i.requestId === r.id),
      })),
    });
  });

  router.post('/items/:itemId/upload', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    // TR-5 impersonation sessions are read-only.
    if ((session as { impersonated?: boolean }).impersonated) {
      res.status(403).json({ error: 'read_only_session' });
      return;
    }
    const parsed = PortalUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const storage = getStorage(deps);
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }

    // Item → request → must belong to the active client + firm and be OPEN.
    const [item] = await deps.db
      .select({
        id: documentRequestItems.id,
        status: documentRequestItems.status,
        label: documentRequestItems.label,
        requestId: documentRequests.id,
        requestStatus: documentRequests.status,
        targetSubfolderPath: documentRequests.targetSubfolderPath,
        clientId: documentRequests.clientId,
        firmId: documentRequests.firmId,
      })
      .from(documentRequestItems)
      .innerJoin(documentRequests, eq(documentRequests.id, documentRequestItems.requestId))
      .where(eq(documentRequestItems.id, req.params['itemId']!))
      .limit(1);
    if (!item || item.clientId !== session.activeClientId || item.firmId !== session.firmId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (item.requestStatus !== 'OPEN') {
      res.status(409).json({ error: 'request_closed' });
      return;
    }

    let body: Buffer;
    try {
      body = Buffer.from(parsed.data.contentBase64, 'base64');
    } catch {
      res.status(400).json({ error: 'invalid_content_base64' });
      return;
    }
    if (body.byteLength === 0 || body.byteLength > PORTAL_UPLOAD_MAX_BYTES) {
      res.status(413).json({ error: 'file_too_large', max: PORTAL_UPLOAD_MAX_BYTES });
      return;
    }

    const folder = await loadClientFolder(deps.db, session.firmId, session.activeClientId);
    if (!folder) {
      res.status(409).json({ error: 'client_folder_not_bound' });
      return;
    }

    const subfolder = item.targetSubfolderPath;
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
      logger.error({ err }, 'portal document upload failed');
      res.status(502).json({ error: 'put_failed' });
      return;
    }

    const [fileRow] = await deps.db
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
    const fileId = fileRow!.id;

    await deps.db
      .update(documentRequestItems)
      .set({ status: 'UPLOADED', fileId, uploadedAt: new Date() })
      .where(eq(documentRequestItems.id, item.id));

    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'file',
      entityId: fileId,
      actorPortalIdentityId: session.portalIdentityId,
      after: {
        clientId: session.activeClientId,
        storageKey,
        source: 'portal_document_request',
        documentRequestItemId: item.id,
        sizeBytes: body.byteLength,
      },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);

    res.status(201).json({ ok: true, fileId, itemId: item.id });
  });

  return router;
}
