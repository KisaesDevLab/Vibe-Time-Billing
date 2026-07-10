// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Message attachments (images/files) shared by the client (engagement) and
// internal (team) messaging routers. Bytes are encrypted under the thread
// T-DEK — the same key as the message body — and stored at
// messages/attachments/<threadId>/<attachmentId>. The original filename is
// encrypted too. Upload first (pending, message_id null), then the POST
// /messages call links the attachment ids to the new message.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clients, threadAttachments, threads } from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { logger } from '../logger';
import { getApplianceLockState } from '../crypto/boot';
import {
  encryptBytesForThread,
  decryptBytesForThread,
  encryptForThread,
  decryptForThread,
} from '../engagement-messaging/thread-crypto';
import { createFileInClientFolder } from '../clients/create-file';
import { CATEGORY_VALUES, type Category } from '../clients/files';

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

// Only these MIME types may be served inline (rendered in the browser).
// Anything else — notably text/html, svg, json — is forced to a download
// with a generic content-type so a thread member can't upload an HTML
// "attachment" that executes script in the app origin when previewed.
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf)$/i;

/** Strip control chars (incl. CR/LF) and quotes so the value is safe inside
 *  a quoted Content-Disposition filename. */
function safeHeaderFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f || c === 0x22 || c === 0x5c) continue;
    out += ch;
  }
  return out.slice(0, 200) || 'attachment';
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

/** Result of authorizing a caller for a thread: the thread firm (for
 *  crypto) + an optional staff actor to stamp on uploads. */
export interface AttachmentAuth {
  firmId: string;
  actorAppUserId?: string;
}

export interface AttachmentRouteDeps {
  db: Database | null;
  storageClient?: StorageClient;
  /** Authorize the caller for the thread (membership enforced inside) and
   *  return its firmId + optional staff actor, or null → 403. The only auth
   *  difference between the staff and portal mounts. */
  authorize: (req: Request, threadId: string) => Promise<AttachmentAuth | null>;
  /** Staff-only: when true, also mount POST …/file-to-folder which copies
   *  an attachment into a client folder (decrypt → register a `files`
   *  row). The portal mount leaves this off so clients can't file. */
  allowFileToClientFolder?: boolean;
}

const FileToFolderSchema = z.object({
  clientId: z.string().uuid().optional(),
  subfolderPath: z.string().max(512).optional(),
  category: z.enum(CATEGORY_VALUES).optional(),
});

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
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const threadId = req.params['id']!;
      const auth = await deps.authorize(req, threadId);
      if (!auth) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      if (!unlocked(auth.firmId)) {
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
        const ctx = { db: deps.db, firmId: auth.firmId, threadId };
        const [row] = await deps.db
          .insert(threadAttachments)
          .values({
            firmId: auth.firmId,
            threadId,
            objectKey: 'pending',
            originalFilenameEnc: Buffer.from(await encryptForThread(ctx, filename)),
            mimeType,
            byteSize: body.byteLength,
            createdByAppUserId: auth.actorAppUserId ?? null,
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
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const threadId = req.params['id']!;
    const auth = await deps.authorize(req, threadId);
    if (!auth) {
      res.status(403).json({ error: 'not_a_member' });
      return;
    }
    if (!unlocked(auth.firmId)) {
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
          eq(threads.firmId, auth.firmId),
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
        { db: deps.db, firmId: auth.firmId, threadId },
        Buffer.concat(chunks),
      );
      const filename = row.nameEnc
        ? ((await decryptForThread(
            { db: deps.db, firmId: auth.firmId, threadId },
            row.nameEnc,
          ).catch(() => null)) ?? 'attachment')
        : 'attachment';
      // Only image/PDF may render inline; everything else (notably an
      // uploaded text/html "attachment") is forced to a download with a
      // generic type so it can't execute as script in the app origin.
      const forced = Boolean(req.query['download']);
      const inlineSafe = !forced && INLINE_SAFE.test(row.mimeType ?? '');
      res.setHeader('Content-Type', inlineSafe ? row.mimeType! : 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        `${inlineSafe ? 'inline' : 'attachment'}; filename="${safeHeaderFilename(filename)}"`,
      );
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(Buffer.from(plain));
    } catch (err) {
      logger.warn({ err, threadId }, 'attachment download failed');
      // Guard against a double-send if bytes were already flushed.
      if (!res.headersSent) res.status(404).json({ error: 'object_gone' });
    }
  });

  if (!deps.allowFileToClientFolder) return;

  // POST /threads/:id/attachments/:attId/file-to-folder   (staff only)
  //
  // Copy an attachment into a client's folder: decrypt the thread-sealed
  // bytes + filename, then register a `files` row via the shared upload
  // helper (Windows-safe name, keep-both collision rename, audit). The
  // target client comes from the thread when it's client-scoped; internal
  // (staff-to-staff) threads carry no client, so the caller picks one.
  // Filed copies are internal-only (visibility 'private'); the original
  // attachment stays on the thread.
  router.post(
    '/threads/:id/attachments/:attId/file-to-folder',
    express.json(),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const threadId = req.params['id']!;
      const auth = await deps.authorize(req, threadId);
      if (!auth || !auth.actorAppUserId) {
        res.status(403).json({ error: 'not_a_member' });
        return;
      }
      if (!unlocked(auth.firmId)) {
        res.status(503).json({ error: 'appliance_locked' });
        return;
      }
      const parsed = FileToFolderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const storage = storageOrNull(deps.storageClient);
      if (!storage) {
        res.status(503).json({ error: 'storage_unavailable' });
        return;
      }

      const [row] = await deps.db
        .select({
          objectKey: threadAttachments.objectKey,
          nameEnc: threadAttachments.originalFilenameEnc,
          mimeType: threadAttachments.mimeType,
          threadClientId: threads.clientId,
        })
        .from(threadAttachments)
        .innerJoin(threads, eq(threads.id, threadAttachments.threadId))
        .where(
          and(
            eq(threadAttachments.id, req.params['attId']!),
            eq(threadAttachments.threadId, threadId),
            eq(threads.firmId, auth.firmId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      // Resolve the destination client: the thread's client for a
      // client-scoped thread, otherwise the caller's pick (validated to
      // the firm). A client-scoped thread ignores any override.
      let clientId = row.threadClientId;
      if (!clientId) {
        if (!parsed.data.clientId) {
          res.status(400).json({ error: 'client_required' });
          return;
        }
        const [c] = await deps.db
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, auth.firmId)))
          .limit(1);
        if (!c) {
          res.status(404).json({ error: 'client_not_found' });
          return;
        }
        clientId = c.id;
      }

      try {
        const obj = await storage.get(row.objectKey);
        const chunks: Buffer[] = [];
        for await (const chunk of obj.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        const plain = await decryptBytesForThread(
          { db: deps.db, firmId: auth.firmId, threadId },
          Buffer.concat(chunks),
        );
        const filename = row.nameEnc
          ? ((await decryptForThread(
              { db: deps.db, firmId: auth.firmId, threadId },
              row.nameEnc,
            ).catch(() => null)) ?? 'attachment')
          : 'attachment';

        const category: Category = parsed.data.category ?? 'other';
        const result = await createFileInClientFolder(deps.db, storage, {
          firmId: auth.firmId,
          clientId,
          actorId: auth.actorAppUserId,
          category,
          subfolderPath: parsed.data.subfolderPath,
          // Decision: filed attachments are internal-only; staff publish
          // later from the Files module if the client should see them.
          visibility: 'private',
          originalFilename: filename,
          body: Buffer.from(plain),
          mimeType: row.mimeType,
          source: 'message_attachment',
        });
        if (!result.ok) {
          res.status(result.code === 'client_folder_not_bound' ? 400 : 502).json({
            error: result.code,
            detail: result.detail,
          });
          return;
        }
        res.status(201).json({
          ok: true,
          fileId: result.fileId,
          clientId,
          filename,
        });
      } catch (err) {
        logger.warn({ err, threadId }, 'attachment file-to-folder failed');
        if (!res.headersSent) res.status(502).json({ error: 'file_failed' });
      }
    },
  );
}
