// SPDX-License-Identifier: Elastic-2.0
//
// Portal file endpoints (Phase 11 of FILE_MANAGER_ADDENDUM.md).
//
//   GET /api/portal/files
//     Lists the active client's `client_visible`, non-deleted files,
//     grouped by subfolder. Sorted by (subfolder, filename). No
//     pending_upload rows.
//
//   GET /api/portal/files/:id/download
//     Re-validates visibility + ownership + soft-delete + pending
//     state, applies a 60/hour/portal-user rate limit, presigns a
//     5-minute GET URL, and logs to file_access_log. Returns a 302
//     redirect for direct download flows OR JSON {url} when
//     `?format=json` is supplied.
//
// Visibility = 'client_visible' is the hard gate; the portal-side
// listing query enforces it, and the download endpoint repeats the
// check to defend against time-of-check/time-of-use races (a staff
// flip from client_visible → private between list and download
// must result in 404, not a successful download).
//
// Per CLAUDE.md non-negotiable #6: every mutation produces an
// audit_log row. file_access_log covers the read-side; mutating
// portal actions (none here) would emit to audit_log too.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';

import { checkAndIncrement } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import { clientFolders, fileAccessLog, files } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import type { Redis } from 'ioredis';

import { addUuidIdGuard } from '../lib/uuid-guard';

export interface PortalFileRoutesDeps {
  db: Database | null;
  redis: Redis;
  requireAuth: (req: Request, res: Response, next: () => void) => Promise<void> | void;
  /** Pre-built storage client. When omitted, the factory is invoked. */
  storageClient?: StorageClient;
}

const DOWNLOAD_RATE_LIMIT_MAX = 60;
const DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const PRESIGN_GET_TTL_SECONDS = 5 * 60;

const ListQuerySchema = z.object({
  subfolder: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function getStorage(deps: PortalFileRoutesDeps): StorageClient | null {
  if (deps.storageClient) return deps.storageClient;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.ip ?? '0.0.0.0').trim();
}

async function logAccess(
  db: Database,
  args: {
    firmId: string;
    fileId: string | null;
    clientId: string;
    portalIdentityId: string | null;
    requestedStorageKey: string | null;
    outcome:
      | 'allowed'
      | 'denied_visibility'
      | 'denied_ownership'
      | 'denied_rate_limit'
      | 'denied_not_found'
      | 'denied_pending'
      | 'denied_deleted';
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  try {
    await db.insert(fileAccessLog).values(args);
  } catch {
    // Access logging is best-effort — never fail the user-facing
    // request because the log write failed. The audit/monitoring path
    // will catch persistent failures.
  }
}

export function createPortalFileRouter(deps: PortalFileRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    const limit = parsed.data.limit ?? 200;

    const rows = await deps.db
      .select({
        id: files.id,
        subfolderPath: files.subfolderPath,
        originalFilename: files.originalFilename,
        mimeType: files.mimeType,
        sizeBytes: files.sizeBytes,
        category: files.category,
        uploadedAt: files.uploadedAt,
        modifiedAt: files.modifiedAt,
        clientFolderId: files.clientFolderId,
      })
      .from(files)
      .innerJoin(clientFolders, eq(clientFolders.id, files.clientFolderId))
      .where(
        and(
          eq(files.firmId, session.firmId),
          eq(files.clientId, session.activeClientId),
          eq(files.visibility, 'client_visible'),
          eq(files.pendingUpload, false),
          isNull(files.deletedAt),
          // Belt-and-suspenders: also filter by the folder belonging to
          // the same firm/client. A misbehaving sync worker could leave
          // a row with a mismatched client_folder_id; this defends.
          eq(clientFolders.firmId, session.firmId),
          eq(clientFolders.clientId, session.activeClientId),
        ),
      )
      .orderBy(asc(files.subfolderPath), asc(files.originalFilename))
      .limit(limit);

    res.json({ items: rows });
  });

  router.get('/:id/download', deps.requireAuth, async (req: Request, res: Response) => {
    const session = req.portalSession!;
    const fileId = req.params['id']!;
    const wantsJson = req.query['format'] === 'json';
    const ip = clientIp(req);
    const userAgent = req.get('user-agent') ?? null;

    if (!deps.db) {
      res.status(404).json({ error: 'no_db' });
      return;
    }
    const db = deps.db;
    const storage = getStorage(deps);
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }

    // ----- Rate limit ----------------------------------------------------
    const rl = await checkAndIncrement(deps.redis, {
      key: `portal:dl:${session.portalIdentityId}`,
      windowSeconds: DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS,
      max: DOWNLOAD_RATE_LIMIT_MAX,
    });
    if (!rl.allowed) {
      await logAccess(db, {
        firmId: session.firmId,
        fileId,
        clientId: session.activeClientId,
        portalIdentityId: session.portalIdentityId,
        requestedStorageKey: null,
        outcome: 'denied_rate_limit',
        ip,
        userAgent,
      });
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: rl.retryAfterSeconds });
      return;
    }

    // ----- Authorization (visibility + ownership + soft-delete) ---------
    const [row] = await db
      .select({
        id: files.id,
        firmId: files.firmId,
        clientId: files.clientId,
        storageKey: files.storageKey,
        originalFilename: files.originalFilename,
        mimeType: files.mimeType,
        visibility: files.visibility,
        pendingUpload: files.pendingUpload,
        deletedAt: files.deletedAt,
      })
      .from(files)
      .where(eq(files.id, fileId))
      .limit(1);

    if (!row) {
      await logAccess(db, {
        firmId: session.firmId,
        fileId: null,
        clientId: session.activeClientId,
        portalIdentityId: session.portalIdentityId,
        requestedStorageKey: null,
        outcome: 'denied_not_found',
        ip,
        userAgent,
      });
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Firm boundary first: even leaking the existence of cross-firm
    // files is bad. Treat as not_found, not denied_ownership.
    if (row.firmId !== session.firmId || row.clientId !== session.activeClientId) {
      await logAccess(db, {
        firmId: session.firmId,
        fileId: row.id,
        clientId: session.activeClientId,
        portalIdentityId: session.portalIdentityId,
        requestedStorageKey: row.storageKey,
        outcome: 'denied_ownership',
        ip,
        userAgent,
      });
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (row.deletedAt) {
      await logAccess(db, {
        firmId: session.firmId,
        fileId: row.id,
        clientId: session.activeClientId,
        portalIdentityId: session.portalIdentityId,
        requestedStorageKey: row.storageKey,
        outcome: 'denied_deleted',
        ip,
        userAgent,
      });
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (row.pendingUpload) {
      await logAccess(db, {
        firmId: session.firmId,
        fileId: row.id,
        clientId: session.activeClientId,
        portalIdentityId: session.portalIdentityId,
        requestedStorageKey: row.storageKey,
        outcome: 'denied_pending',
        ip,
        userAgent,
      });
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (row.visibility !== 'client_visible') {
      await logAccess(db, {
        firmId: session.firmId,
        fileId: row.id,
        clientId: session.activeClientId,
        portalIdentityId: session.portalIdentityId,
        requestedStorageKey: row.storageKey,
        outcome: 'denied_visibility',
        ip,
        userAgent,
      });
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // ----- Presign + log + respond --------------------------------------
    const url = await storage.presignGet(row.storageKey, PRESIGN_GET_TTL_SECONDS);
    await logAccess(db, {
      firmId: session.firmId,
      fileId: row.id,
      clientId: session.activeClientId,
      portalIdentityId: session.portalIdentityId,
      requestedStorageKey: row.storageKey,
      outcome: 'allowed',
      ip,
      userAgent,
    });

    if (wantsJson) {
      res.json({
        url,
        expiresAt: new Date(Date.now() + PRESIGN_GET_TTL_SECONDS * 1000).toISOString(),
        filename: row.originalFilename,
        mimeType: row.mimeType,
      });
      return;
    }
    // Default flow: 302 to the presigned URL so an anchor click delivers
    // the file directly. For mock storage the URL is opaque (mock-
    // presign://) and the client must use ?format=json instead.
    if (!/^https?:\/\//.test(url)) {
      res.json({
        url,
        expiresAt: new Date(Date.now() + PRESIGN_GET_TTL_SECONDS * 1000).toISOString(),
        filename: row.originalFilename,
      });
      return;
    }
    res.redirect(302, url);
  });

  return router;
}
