// SPDX-License-Identifier: Elastic-2.0
//
// CP11 / 0102 — Public file-share endpoint.
//
// GET /api/shared/:token
//   No portal authentication. Token-only access — the URL itself is the
//   bearer credential (argon2-hashed at rest; legacy sha256 tokens still
//   accepted). The SHARE authorizes the file, so visibility is NOT
//   required (a staff share can expose a private file deliberately).
//   Validates: not revoked, not expired, file present + not deleted.
//   On success: for a PDF flagged watermark, streams a recipient-stamped
//   copy; otherwise redirects to a fresh presigned URL. Every access —
//   allowed or denied — writes a file_share_event row.
//
// Mounted at /api/shared/* outside the portal-auth chain, isolated so a
// bug in portal middleware can't gate the share flow.

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { files } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { logger } from './logger';
import { resolveFileShareToken, type ResolvedFileShare } from './sharing/file-share-helper';
import { logShareEvent, serveSharedFile } from './sharing/serve-shared-file';

export interface SharePublicDeps {
  db: Database | null;
  storageClient?: StorageClient;
  /** Landing-page origin for redirecting gated rows (0150). */
  portalBaseUrl?: string;
}

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

export function createSharePublicRouter(deps: SharePublicDeps): Router {
  const router = express.Router();

  router.get('/:token', async (req: Request, res: Response) => {
    const token = req.params['token'] ?? '';
    const ip = clientIp(req);
    const userAgent = req.get('user-agent') ?? null;
    // Accept legacy 64-hex tokens and new `<uuid>.<base64url>` tokens.
    if (!/^[A-Za-z0-9._-]{20,400}$/.test(token)) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    if (!deps.db) {
      res.status(503).type('text/plain').send('Service unavailable');
      return;
    }

    let share: ResolvedFileShare | null;
    try {
      share = await resolveFileShareToken(deps.db, token);
    } catch (err) {
      logger.error({ err }, 'share token resolve failed');
      res.status(500).type('text/plain').send('Could not open this link.');
      return;
    }
    if (!share) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    // 0150 — gated shares never serve bytes from the direct path. New
    // links point at the landing page already; a hit here is a trimmed
    // URL (redirect = good UX) or a gate-bypass attempt (redirect = no
    // bytes). Pre-0150 rows (gated=false) keep direct-serving below.
    if (share.gated) {
      await logShareEvent(deps.db, share.id, 'denied_gated', ip, userAgent);
      const base = (deps.portalBaseUrl ?? '').replace(/\/$/, '');
      res.redirect(302, `${base}/shared/file/${token}`);
      return;
    }
    if (share.revokedAt || share.status === 'REVOKED') {
      await logShareEvent(deps.db, share.id, 'denied_revoked', ip, userAgent);
      res.status(410).type('text/plain').send('This link has been revoked.');
      return;
    }
    if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
      await logShareEvent(deps.db, share.id, 'denied_expired', ip, userAgent);
      res.status(410).type('text/plain').send('This link has expired.');
      return;
    }

    const [file] = await deps.db
      .select({
        id: files.id,
        storageKey: files.storageKey,
        originalFilename: files.originalFilename,
        mimeType: files.mimeType,
        deletedAt: files.deletedAt,
        pendingUpload: files.pendingUpload,
      })
      .from(files)
      .where(eq(files.id, share.fileId))
      .limit(1);
    // The share itself grants access — visibility is NOT required here.
    if (!file || file.deletedAt != null || file.pendingUpload) {
      await logShareEvent(deps.db, share.id, 'denied_file_gone', ip, userAgent);
      res.status(410).type('text/plain').send('This file is no longer available.');
      return;
    }

    const storage = getStorage(deps);
    if (!storage) {
      res.status(503).type('text/plain').send('Storage unavailable.');
      return;
    }

    await serveSharedFile({
      db: deps.db,
      storage,
      share,
      file,
      res,
      disposition: share.accessLevel === 'download' ? 'attachment' : 'inline',
      ip,
      userAgent,
    });
  });

  return router;
}
