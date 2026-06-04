// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Message attachments (images/files) shared by the client (engagement) and
// internal (team) messaging routers. Bytes are encrypted under the thread
// T-DEK — the same key as the message body — and stored at
// messages/attachments/<threadId>/<attachmentId>. The original filename is
// encrypted too. Upload first (pending, message_id null), then the POST
// /messages call links the attachment ids to the new message.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { threadAttachments, threads } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { logger } from '../logger';
import { getApplianceLockState } from '../crypto/boot';
import {
  encryptBytesForThread,
  decryptBytesForThread,
  encryptForThread,
  decryptForThread,
} from '../engagement-messaging/thread-crypto';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const BLOCKED_EXT =
  /\.(exe|com|bat|cmd|msi|scr|pif|cpl|js|jse|vbs|vbe|wsf|wsh|ps1|sh|jar|app|dll|sys|reg)$/i;
const PREFIX = 'messages/attachments';

export interface AttachmentMeta {
  id: string;
  filename: string | null;
  mimeType: string | null;
  byteSize: number;
  isImage: boolean;
}

function storageOrNull(injected?: StorageClient): StorageClient | null {
  if (injected) return injected;
  try {
    return buildStorageClient(process.env);
  } catch {
    return null;
  }
}

function isImage(mime: string | null): boolean {
  return Boolean(mime && mime.toLowerCase().startsWith('image/'));
}

/** Decrypt + group attachments for a set of messages in one thread. */
export async function listAttachmentsByMessage(
  db: Database,
  firmId: string,
  threadId: string,
  messageIds: string[],
): Promise<Map<string, AttachmentMeta[]>> {
  const out = new Map<string, AttachmentMeta[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      id: threadAttachments.id,
      messageId: threadAttachments.messageId,
      nameEnc: threadAttachments.originalFilenameEnc,
      mimeType: threadAttachments.mimeType,
      byteSize: threadAttachments.byteSize,
    })
    .from(threadAttachments)
    .where(
      and(
        eq(threadAttachments.threadId, threadId),
        inArray(threadAttachments.messageId, messageIds),
      ),
    );
  for (const r of rows) {
    if (!r.messageId) continue;
    let filename: string | null = null;
    try {
      filename = r.nameEnc ? await decryptForThread({ db, firmId, threadId }, r.nameEnc) : null;
    } catch {
      filename = null;
    }
    const meta: AttachmentMeta = {
      id: r.id,
      filename,
      mimeType: r.mimeType,
      byteSize: Number(r.byteSize),
      isImage: isImage(r.mimeType),
    };
    const list = out.get(r.messageId) ?? [];
    list.push(meta);
    out.set(r.messageId, list);
  }
  return out;
}

/** Link pending (unsent) attachments to a freshly-posted message. Only
 *  attachments in the same thread with no message yet are linked. */
export async function linkPendingAttachments(
  db: Database,
  threadId: string,
  messageId: string,
  attachmentIds: string[],
): Promise<void> {
  if (!attachmentIds || attachmentIds.length === 0) return;
  await db
    .update(threadAttachments)
    .set({ messageId })
    .where(
      and(
        eq(threadAttachments.threadId, threadId),
        inArray(threadAttachments.id, attachmentIds),
        isNull(threadAttachments.messageId),
      ),
    );
}

export interface AttachmentRouteDeps {
  db: Database | null;
  storageClient?: StorageClient;
  /** Membership + firm scope check for the acting staff user. */
  isMember: (threadId: string, appUserId: string) => Promise<boolean>;
}

/** Mount POST upload + GET download/preview on a thread-scoped router. */
export function mountThreadAttachmentRoutes(router: Router, deps: AttachmentRouteDeps): void {
  function unlocked(firmId: string): boolean {
    const lock = getApplianceLockState();
    return lock.kind === 'unlocked' && lock.firmId === firmId;
  }

  // POST /threads/:id/attachments?filename=&mimeType=  (raw body)
  router.post(
    '/threads/:id/attachments',
    express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES + 1024 }),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const threadId = req.params['id']!;
      if (!(await deps.isMember(threadId, session.appUserId))) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      if (!unlocked(session.firmId)) {
        res.status(503).json({ error: 'appliance_locked' });
        return;
      }
      const filename =
        String(req.query['filename'] ?? '')
          .trim()
          .slice(0, 255) || 'attachment';
      const mimeType = String(req.query['mimeType'] ?? 'application/octet-stream').slice(0, 200);
      if (BLOCKED_EXT.test(filename)) {
        res.status(415).json({ error: 'unsupported_type' });
        return;
      }
      const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.byteLength === 0) {
        res.status(400).json({ error: 'empty_body' });
        return;
      }
      if (body.byteLength > MAX_ATTACHMENT_BYTES) {
        res.status(413).json({ error: 'file_too_large' });
        return;
      }
      const storage = storageOrNull(deps.storageClient);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }
      try {
        const ctx = { db: deps.db, firmId: session.firmId, threadId };
        const [row] = await deps.db
          .insert(threadAttachments)
          .values({
            firmId: session.firmId,
            threadId,
            objectKey: 'pending',
            originalFilenameEnc: Buffer.from(await encryptForThread(ctx, filename)),
            mimeType,
            byteSize: body.byteLength,
            createdByAppUserId: session.appUserId,
          })
          .returning({ id: threadAttachments.id });
        const attId = row!.id;
        const objectKey = `${PREFIX}/${threadId}/${attId}`;
        const sealed = await encryptBytesForThread(ctx, body);
        await storage.put(objectKey, Buffer.from(sealed), {
          contentType: 'application/octet-stream',
        });
        await deps.db
          .update(threadAttachments)
          .set({ objectKey })
          .where(eq(threadAttachments.id, attId));
        res.status(201).json({
          id: attId,
          filename,
          mimeType,
          byteSize: body.byteLength,
          isImage: isImage(mimeType),
        });
      } catch (err) {
        logger.error({ err, threadId }, 'attachment upload failed');
        res.status(502).json({ error: 'upload_failed' });
      }
    },
  );

  // GET /threads/:id/attachments/:attId   (inline preview; ?download=1 forces save)
  router.get('/threads/:id/attachments/:attId', async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const threadId = req.params['id']!;
    if (!(await deps.isMember(threadId, session.appUserId))) {
      res.status(403).json({ error: 'not_a_member' });
      return;
    }
    if (!unlocked(session.firmId)) {
      res.status(503).json({ error: 'appliance_locked' });
      return;
    }
    const [row] = await deps.db
      .select({
        objectKey: threadAttachments.objectKey,
        nameEnc: threadAttachments.originalFilenameEnc,
        mimeType: threadAttachments.mimeType,
        firmId: threadAttachments.firmId,
      })
      .from(threadAttachments)
      .innerJoin(threads, eq(threads.id, threadAttachments.threadId))
      .where(
        and(
          eq(threadAttachments.id, req.params['attId']!),
          eq(threadAttachments.threadId, threadId),
          eq(threads.firmId, session.firmId),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const storage = storageOrNull(deps.storageClient);
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    try {
      const obj = await storage.get(row.objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of obj.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const plain = await decryptBytesForThread(
        { db: deps.db, firmId: session.firmId, threadId },
        Buffer.concat(chunks),
      );
      const filename = row.nameEnc
        ? ((await decryptForThread(
            { db: deps.db, firmId: session.firmId, threadId },
            row.nameEnc,
          ).catch(() => null)) ?? 'attachment')
        : 'attachment';
      res.setHeader('Content-Type', row.mimeType ?? 'application/octet-stream');
      const disp = req.query['download'] ? 'attachment' : 'inline';
      res.setHeader('Content-Disposition', `${disp}; filename="${filename.replace(/"/g, '')}"`);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(Buffer.from(plain));
    } catch (err) {
      logger.warn({ err, threadId }, 'attachment download failed');
      res.status(404).json({ error: 'object_gone' });
    }
  });
}
