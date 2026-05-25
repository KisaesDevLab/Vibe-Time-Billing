// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP11 — Public file-share endpoint (Build Plan §2.4).
//
// GET /api/shared/:token
//   No portal authentication. Token-only access — the URL itself is
//   the bearer credential. Server validates: token unrevoked, not
//   expired, file still client-visible + not deleted. On success
//   redirects to a fresh presigned URL (mirrors the portal download
//   flow). Every access — allowed or denied — writes a file_share_event
//   row so the firm + creator can see who has been opening the link.
//
// Mounted at /api/shared/* outside the portal-auth chain. We deliberately
// keep this isolated from the portal/* tree so a bug in portal middleware
// can't accidentally gate the share flow.

import { createHash } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { fileShareEvents, fileShares, files } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { addUuidIdGuard } from './lib/uuid-guard';
import { logger } from './logger';

export interface SharePublicDeps {
  db: Database | null;
  storageClient?: StorageClient;
}

const PRESIGN_TTL_SECONDS = 5 * 60;

function getStorage(deps: SharePublicDeps): StorageClient | null {
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

async function logEvent(
  db: Database,
  fileShareId: string,
  outcome: 'allowed' | 'denied_revoked' | 'denied_expired' | 'denied_file_gone',
  ip: string,
  userAgent: string | null,
): Promise<void> {
  try {
    await db.insert(fileShareEvents).values({
      fileShareId,
      outcome,
      ip,
      userAgent,
    });
    if (outcome === 'allowed') {
      await db
        .update(fileShares)
        .set({
          accessCount: sql`${fileShares.accessCount} + 1`,
          lastAccessedAt: new Date(),
        })
        .where(eq(fileShares.id, fileShareId));
    }
  } catch (err) {
    logger.error({ err, fileShareId, outcome }, 'file_share_event insert failed');
  }
}

export function createSharePublicRouter(deps: SharePublicDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/:token', async (req: Request, res: Response) => {
    const token = req.params['token'] ?? '';
    const ip = clientIp(req);
    const userAgent = req.get('user-agent') ?? null;
    // Tokens are 64-char hex (32 bytes). Reject anything obviously not.
    if (!/^[0-9a-f]{32,128}$/i.test(token)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    if (!deps.db) {
      res.status(503).type('text/plain').send('Service unavailable');
      return;
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [share] = await deps.db
      .select({
        id: fileShares.id,
        fileId: fileShares.fileId,
        accessLevel: fileShares.accessLevel,
        expiresAt: fileShares.expiresAt,
        revokedAt: fileShares.revokedAt,
      })
      .from(fileShares)
      .where(eq(fileShares.tokenHash, tokenHash))
      .limit(1);
    if (!share) {
      // Don't leak whether the token was ever valid. Generic 404.
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    if (share.revokedAt) {
      await logEvent(deps.db, share.id, 'denied_revoked', ip, userAgent);
      res.status(410).type('text/plain').send('This link has been revoked.');
      return;
    }
    if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
      await logEvent(deps.db, share.id, 'denied_expired', ip, userAgent);
      res.status(410).type('text/plain').send('This link has expired.');
      return;
    }
    const [file] = await deps.db
      .select({
        id: files.id,
        storageKey: files.storageKey,
        originalFilename: files.originalFilename,
        mimeType: files.mimeType,
        visibility: files.visibility,
        deletedAt: files.deletedAt,
        pendingUpload: files.pendingUpload,
      })
      .from(files)
      .where(eq(files.id, share.fileId))
      .limit(1);
    if (
      !file ||
      file.deletedAt != null ||
      file.pendingUpload ||
      file.visibility !== 'client_visible'
    ) {
      await logEvent(deps.db, share.id, 'denied_file_gone', ip, userAgent);
      res.status(410).type('text/plain').send('This file is no longer available.');
      return;
    }
    const storage = getStorage(deps);
    if (!storage) {
      res.status(503).type('text/plain').send('Storage unavailable.');
      return;
    }
    try {
      const url = await storage.presignGet(file.storageKey, PRESIGN_TTL_SECONDS);
      await logEvent(deps.db, share.id, 'allowed', ip, userAgent);
      // Mock storage returns opaque URIs (mock-presign://...). Surface
      // the URL via JSON in that case so the dev environment can still
      // navigate / inspect.
      if (!/^https?:\/\//.test(url)) {
        res.json({
          ok: true,
          mode: 'mock',
          url,
          filename: file.originalFilename,
          mimeType: file.mimeType,
          accessLevel: share.accessLevel,
        });
        return;
      }
      res.redirect(302, url);
    } catch (err) {
      logger.error({ err, shareId: share.id }, 'shared presign failed');
      res.status(500).type('text/plain').send('Could not generate access URL.');
    }
  });

  return router;
}

// Suppress unused-imports lint when the file-not-found branch isn't taken
// during typecheck.
void and;
void isNull;
