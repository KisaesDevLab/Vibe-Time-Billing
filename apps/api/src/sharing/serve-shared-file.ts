// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0150 — shared serving core for externally shared files, used by both
// the legacy direct endpoint (/api/shared/:token, share-public.ts) and
// the gated recipient API (/api/shared-file, share-public/file-recipient.ts).
//
// Watermarked PDFs are always streamed (the bytes must be rewritten);
// the gated flow additionally streams UN-watermarked PDFs so the
// landing page's same-origin canvas viewer can fetch them (a cross-
// origin presigned URL would both break pdf.js and hand out an ungated
// URL). Everything else 302s to a short-lived presigned URL.

import type { Readable } from 'node:stream';
import type { Response } from 'express';

import type { Database } from '@vibe/db';
import { fileShareEvents } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

import { logger } from '../logger';
import { markFileShareViewed, type ResolvedFileShare } from './file-share-helper';
import { recordShareAccessNote } from './share-notes';
import { watermarkPdf, recipientWatermarkText } from './watermark-pdf';

export const PRESIGN_TTL_SECONDS = 5 * 60;

export type ShareEventOutcome =
  | 'allowed'
  | 'denied_revoked'
  | 'denied_expired'
  | 'denied_file_gone'
  | 'otp_sent'
  | 'otp_failed'
  | 'otp_verified'
  | 'otp_locked'
  | 'denied_gated'
  | 'denied_not_verified'
  | 'revoked_lockout';

export async function logShareEvent(
  db: Database,
  fileShareId: string,
  outcome: ShareEventOutcome,
  ip: string,
  userAgent: string | null,
): Promise<void> {
  try {
    await db.insert(fileShareEvents).values({ fileShareId, outcome, ip, userAgent });
  } catch (err) {
    logger.error({ err, fileShareId, outcome }, 'file_share_event insert failed');
  }
}

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

export function isPdf(mimeType: string | null, filename: string): boolean {
  return mimeType === 'application/pdf' || filename.toLowerCase().endsWith('.pdf');
}

export function safeFilename(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'document';
}

export interface ServableFile {
  storageKey: string;
  originalFilename: string;
  mimeType: string | null;
}

/**
 * Drop a client-timeline note when the 3rd party accesses the file. Every
 * download is noted; a plain view is noted only on the FIRST access
 * (accessCount === 1) so a PDF viewer re-fetching doesn't spam the timeline.
 */
async function noteShareAccess(
  db: Database,
  share: ResolvedFileShare,
  file: ServableFile,
  disposition: 'inline' | 'attachment',
  newAccessCount: number,
): Promise<void> {
  const isDownload = disposition === 'attachment';
  if (!isDownload && newAccessCount !== 1) return;
  await recordShareAccessNote(db, {
    clientId: share.clientId,
    authorAppUserId: share.createdByAppUserId,
    fileLabel: file.originalFilename,
    recipientName: share.recipientName,
    recipientEmail: share.recipientEmail,
    action: isDownload ? 'downloaded' : 'viewed',
  });
}

/**
 * Serve the file for an authorized share access: logs the `allowed`
 * event, bumps view tracking, and either streams PDF bytes (watermarked
 * when flagged) or redirects to a presigned URL. The caller has already
 * validated revocation/expiry/file-presence and (for gated flows) the
 * grant.
 */
export async function serveSharedFile(opts: {
  db: Database;
  storage: StorageClient;
  share: ResolvedFileShare;
  file: ServableFile;
  res: Response;
  disposition: 'inline' | 'attachment';
  ip: string;
  userAgent: string | null;
  /** Stream PDFs even without a watermark (same-origin viewer). */
  forceStreamPdf?: boolean;
}): Promise<void> {
  const { db, storage, share, file, res, disposition, ip, userAgent } = opts;
  try {
    const pdf = isPdf(file.mimeType, file.originalFilename);
    if (pdf && (share.watermark || opts.forceStreamPdf)) {
      const obj = await storage.get(file.storageKey);
      const raw = await streamToBuffer(obj.body);
      const bytes = share.watermark
        ? await watermarkPdf(
            raw,
            recipientWatermarkText({
              recipientName: share.recipientName,
              organization: share.organization,
            }),
          )
        : raw;
      await logShareEvent(db, share.id, 'allowed', ip, userAgent);
      const n = await markFileShareViewed(db, share.id);
      await noteShareAccess(db, share, file, disposition, n);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="${safeFilename(file.originalFilename)}"`,
      );
      res.send(bytes);
      return;
    }

    const url = await storage.presignGet(file.storageKey, PRESIGN_TTL_SECONDS);
    await logShareEvent(db, share.id, 'allowed', ip, userAgent);
    const n = await markFileShareViewed(db, share.id);
    await noteShareAccess(db, share, file, disposition, n);
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
}
