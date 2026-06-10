// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 8 of FILE_MANAGER_ADDENDUM.md — app upload path.
//
// Three client-scoped routes:
//
//   POST /:id/files
//     Reserves a slot for an app upload. Returns a presigned PUT URL
//     (15-min TTL) + a `files` row with pending_upload=true and
//     source='app'. The FE PUTs the body directly to storage and then
//     POSTs /api/staff/files/:id/complete to confirm.
//
//   POST /:id/files/generated
//     Server-side PUT for artifacts the app generates (invoices,
//     engagement letters). Body carries the bytes as base64. Same
//     subfolder routing + sanitize + collision resolution, but the
//     row lands with source='generated' and pending_upload=false.
//
//   GET /:id/files
//     Lists the client's non-deleted files. Tab-friendly shape.
//
// Permission gates per Phase 7: storage:folder:view for reads,
// storage:folder:edit for writes.

import { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clientFolders, clients, files } from '@vibe/db/schema';
import {
  buildStorageClient,
  enforceKeyByteCap,
  joinPath,
  resolveCollision,
  sanitizeForWindows,
  type StorageClient,
} from '@vibe/storage';
import { storage as coreStorage } from '@vibe/core';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { resolveClientFolders } from './folder-templates';

export interface FileRoutesDeps extends RbacDeps {
  db: Database | null;
  /** Pre-built storage client. When omitted, the factory is invoked
   *  with process.env — useful for tests that want to inject a mock. */
  storageClient?: StorageClient;
}

// ---------------------------------------------------------------------------
// Category → subfolder auto-routing (addendum §4 Phase 8 step 3)
// ---------------------------------------------------------------------------

const CATEGORY_VALUES = [
  'invoice',
  'engagement_letter',
  'receipt',
  'time_entry_support',
  'correspondence',
  'other',
] as const;
export type Category = (typeof CATEGORY_VALUES)[number];
export { CATEGORY_VALUES };

const CATEGORY_SUBFOLDER: Record<Category, string> = {
  invoice: 'Invoices/',
  engagement_letter: 'Engagement Letters/',
  receipt: 'Receipts/',
  time_entry_support: 'Time Entry Support/',
  correspondence: 'Correspondence/',
  other: '',
};

const PRESIGN_TTL_SECONDS = 15 * 60;

const ReserveSchema = z.object({
  category: z.enum(CATEGORY_VALUES),
  subfolderPath: z.string().max(512).optional(),
  visibility: z.enum(['private', 'client_visible']).optional(),
  originalFilename: z.string().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .min(0)
    .max(50 * 1024 * 1024 * 1024), // 50GB cap
  mimeType: z.string().max(200).optional(),
});

const GeneratedSchema = z.object({
  category: z.enum(CATEGORY_VALUES),
  subfolderPath: z.string().max(512).optional(),
  visibility: z.enum(['private', 'client_visible']).optional(),
  originalFilename: z.string().min(1).max(255),
  mimeType: z.string().max(200).optional(),
  /** Base64-encoded body. Server PUTs directly to storage. */
  contentBase64: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStorage(deps: FileRoutesDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

interface ResolvedFolder {
  clientFolderId: string;
  clientId: string;
  storagePath: string;
  status: string;
  lastSyncedAt: Date | null;
}

export async function loadClientFolder(
  db: Database,
  firmId: string,
  clientId: string,
): Promise<ResolvedFolder | null> {
  const [row] = await db
    .select({
      id: clientFolders.id,
      clientId: clientFolders.clientId,
      storagePath: clientFolders.storagePath,
      status: clientFolders.status,
      lastSyncedAt: clientFolders.lastSyncedAt,
    })
    .from(clientFolders)
    .innerJoin(clients, eq(clients.id, clientFolders.clientId))
    .where(
      and(
        eq(clientFolders.firmId, firmId),
        eq(clientFolders.clientId, clientId),
        eq(clients.firmId, firmId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    clientFolderId: row.id,
    clientId: row.clientId,
    storagePath: row.storagePath,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
  };
}

export function normalizeSubfolder(input: string | undefined, category: Category): string {
  const raw = input ?? CATEGORY_SUBFOLDER[category];
  if (raw === '') return '';
  // Sanitize each segment for Windows-safety and ensure trailing slash.
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) return '';
  const parts = trimmed.split('/').map((s) => sanitizeForWindows(s));
  return `${parts.join('/')}/`;
}

export async function loadFirmVisibilityRules(
  db: Database,
  firmId: string,
): Promise<coreStorage.VisibilityRule[]> {
  const { firmFolderVisibilityRules } = await import('@vibe/db/schema');
  const rows = await db
    .select({
      subfolderPattern: firmFolderVisibilityRules.subfolderPattern,
      defaultVisibility: firmFolderVisibilityRules.defaultVisibility,
      priority: firmFolderVisibilityRules.priority,
      enabled: firmFolderVisibilityRules.enabled,
    })
    .from(firmFolderVisibilityRules)
    .where(eq(firmFolderVisibilityRules.firmId, firmId));
  return rows.map((r) => ({
    subfolderPattern: r.subfolderPattern,
    defaultVisibility: r.defaultVisibility as 'private' | 'client_visible',
    priority: r.priority,
    enabled: r.enabled,
  }));
}

// ---------------------------------------------------------------------------
// Route mounting
// ---------------------------------------------------------------------------

export function mountFileRoutes(router: Router, deps: FileRoutesDeps): void {
  // GET /:id/files — list a client's files (non-deleted only).
  router.get(
    '/:id/files',
    requirePermission(deps, 'storage:folder:view'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const folder = await loadClientFolder(deps.db, session.firmId, req.params['id']!);
      if (!folder) {
        res.json({ items: [], unbound: true });
        return;
      }
      const rows = await deps.db
        .select({
          id: files.id,
          subfolderPath: files.subfolderPath,
          originalFilename: files.originalFilename,
          storageKey: files.storageKey,
          mimeType: files.mimeType,
          sizeBytes: files.sizeBytes,
          sha256: files.sha256,
          etag: files.etag,
          category: files.category,
          source: files.source,
          visibility: files.visibility,
          uploadedAt: files.uploadedAt,
          modifiedAt: files.modifiedAt,
          pendingUpload: files.pendingUpload,
        })
        .from(files)
        .where(and(eq(files.clientFolderId, folder.clientFolderId), isNull(files.deletedAt)))
        .orderBy(asc(files.subfolderPath), asc(files.originalFilename));
      // Virtual folder skeleton from the client's (or firm default) template —
      // shown in the Explorer even when empty.
      const templateFolders = await resolveClientFolders(
        deps.db,
        session.firmId,
        req.params['id']!,
      ).catch(() => []);
      res.json({
        items: rows,
        clientFolderId: folder.clientFolderId,
        storagePath: folder.storagePath,
        status: folder.status,
        lastSyncedAt: folder.lastSyncedAt,
        templateFolders,
      });
    },
  );

  // POST /:id/files — reserve a slot for an app upload.
  router.post(
    '/:id/files',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = ReserveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      const firmId = session.firmId;
      const actorId = session.appUserId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const folder = await loadClientFolder(deps.db, firmId, req.params['id']!);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }

      const subfolder = normalizeSubfolder(parsed.data.subfolderPath, parsed.data.category);
      const safeFilename = sanitizeForWindows(parsed.data.originalFilename);
      const desired = enforceKeyByteCap(joinPath(folder.storagePath, subfolder, safeFilename));
      const storageKey = await resolveCollision(
        desired,
        async (k) => (await storage.head(k)) !== null,
      );

      const visibilityRules = await loadFirmVisibilityRules(deps.db, firmId);
      const visibility =
        parsed.data.visibility ?? coreStorage.resolveDefaultVisibility(subfolder, visibilityRules);

      let uploadUrl: string;
      try {
        // Don't synthesize a content type. If the browser couldn't
        // identify one (file.type === ''), forcing application/octet-
        // stream into the SigV4 signature would lock the PUT to that
        // header value — but the FE sends no Content-Type at all,
        // causing B2 to reject with 403 SignatureDoesNotMatch.
        uploadUrl = await storage.presignPut(
          storageKey,
          {
            contentType: parsed.data.mimeType,
            expectedSizeBytes: parsed.data.sizeBytes,
          },
          PRESIGN_TTL_SECONDS,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'presign_failed';
        res.status(502).json({ error: 'presign_failed', detail: message });
        return;
      }

      const [row] = await deps.db
        .insert(files)
        .values({
          firmId,
          clientId: folder.clientId,
          clientFolderId: folder.clientFolderId,
          subfolderPath: subfolder,
          originalFilename: safeFilename,
          storageKey,
          mimeType: parsed.data.mimeType ?? null,
          sizeBytes: parsed.data.sizeBytes,
          category: parsed.data.category,
          source: 'app',
          visibility,
          uploadedBy: actorId,
          pendingUpload: true,
        })
        .returning({ id: files.id });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'file',
        entityId: row?.id ?? null,
        actorAppUserId: actorId,
        after: {
          clientId: folder.clientId,
          storageKey,
          source: 'app',
          visibility,
          pending: true,
        },
      }).catch(() => undefined);

      res.status(201).json({
        fileId: row?.id ?? null,
        storageKey,
        uploadUrl,
        expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
        visibility,
      });
    },
  );

  // POST /:id/files/generated — server-side PUT for app-generated artifacts.
  router.post(
    '/:id/files/generated',
    requirePermission(deps, 'storage:folder:edit'),
    async (req: Request, res: Response) => {
      const parsed = GeneratedSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      const firmId = session.firmId;
      const actorId = session.appUserId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const storage = getStorage(deps);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      const folder = await loadClientFolder(deps.db, firmId, req.params['id']!);
      if (!folder) {
        res.status(404).json({ error: 'client_folder_not_bound' });
        return;
      }

      let body: Buffer;
      try {
        body = Buffer.from(parsed.data.contentBase64, 'base64');
      } catch {
        res.status(400).json({ error: 'invalid_content_base64' });
        return;
      }

      const subfolder = normalizeSubfolder(parsed.data.subfolderPath, parsed.data.category);
      const safeFilename = sanitizeForWindows(parsed.data.originalFilename);
      const desired = enforceKeyByteCap(joinPath(folder.storagePath, subfolder, safeFilename));
      const storageKey = await resolveCollision(
        desired,
        async (k) => (await storage.head(k)) !== null,
      );

      const visibilityRules = await loadFirmVisibilityRules(deps.db, firmId);
      const visibility =
        parsed.data.visibility ?? coreStorage.resolveDefaultVisibility(subfolder, visibilityRules);

      let etag: string;
      try {
        const result = await storage.put(storageKey, body, {
          contentType: parsed.data.mimeType ?? 'application/octet-stream',
        });
        etag = result.etag;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'put_failed';
        res.status(502).json({ error: 'put_failed', detail: message });
        return;
      }

      const [row] = await deps.db
        .insert(files)
        .values({
          firmId,
          clientId: folder.clientId,
          clientFolderId: folder.clientFolderId,
          subfolderPath: subfolder,
          originalFilename: safeFilename,
          storageKey,
          mimeType: parsed.data.mimeType ?? null,
          sizeBytes: body.byteLength,
          etag,
          category: parsed.data.category,
          source: 'generated',
          visibility,
          uploadedBy: actorId,
          pendingUpload: false,
        })
        .returning({ id: files.id });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'file',
        entityId: row?.id ?? null,
        actorAppUserId: actorId,
        after: {
          clientId: folder.clientId,
          storageKey,
          source: 'generated',
          visibility,
          sizeBytes: body.byteLength,
        },
      }).catch(() => undefined);

      res.status(201).json({
        fileId: row?.id ?? null,
        storageKey,
        sizeBytes: body.byteLength,
        etag,
        visibility,
      });
    },
  );
}
