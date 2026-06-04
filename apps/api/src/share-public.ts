// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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

import type { Readable } from 'node:stream';

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { fileShareEvents, files } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { logger } from './logger';
import {
  resolveFileShareToken,
  markFileShareViewed,
  type ResolvedFileShare,
} from './sharing/file-share-helper';
import { watermarkPdf, recipientWatermarkText } from './sharing/watermark-pdf';

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
    await db.insert(fileShareEvents).values({ fileShareId, outcome, ip, userAgent });
  } catch (err) {
    logger.error({ err, fileShareId, outcome }, 'file_share_event insert failed');
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function isPdf(mimeType: string | null, filename: string): boolean {
  return mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
}

function safeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'document';
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
    if (share.revokedAt || share.status === 'REVOKED') {
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
        deletedAt: files.deletedAt,
        pendingUpload: files.pendingUpload,
      })
      .from(files)
      .where(eq(files.id, share.fileId))
      .limit(1);
    // The share itself grants access — visibility is NOT required here.
    if (!file || file.deletedAt != null || file.pendingUpload) {
      await logEvent(deps.db, share.id, 'denied_file_gone', ip, userAgent);
      res.status(410).type('text/plain').send('This file is no longer available.');
      return;
    }

    const storage = getStorage(deps);
    if (!storage) {
      res.status(503).type('text/plain').send('Storage unavailable.');
      return;
    }

    const disposition = share.accessLevel === 'download' ? 'attachment' : 'inline';

    try {
      // Watermarked PDFs are streamed (we must rewrite the bytes); everything
      // else redirects to a short-lived presigned URL.
      if (share.watermark && isPdf(file.mimeType, file.originalFilename)) {
        const obj = await storage.get(file.storageKey);
        const raw = await streamToBuffer(obj.body);
        const stamped = await watermarkPdf(
          raw,
          recipientWatermarkText({
            recipientName: share.recipientName,
            organization: share.organization,
          }),
        );
        await logEvent(deps.db, share.id, 'allowed', ip, userAgent);
        await markFileShareViewed(deps.db, share.id);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="${safeFilename(file.originalFilename)}"`,
        );
        res.send(stamped);
        return;
      }

      const url = await storage.presignGet(file.storageKey, PRESIGN_TTL_SECONDS);
      await logEvent(deps.db, share.id, 'allowed', ip, userAgent);
      await markFileShareViewed(deps.db, share.id);
      if (!/^https?:\/\//.test(url)) {
        // Mock storage returns opaque URIs — surface via JSON for dev.
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
      logger.error({ err, shareId: share.id }, 'shared access failed');
      res.status(500).type('text/plain').send('Could not generate access URL.');
    }
  });

  return router;
}
