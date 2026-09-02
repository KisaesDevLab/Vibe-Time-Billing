// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Inbound MMS media pipeline (D7), consumed in the API process because
// Document Intake sessions need the firm key. Per sms_media row:
//   fetch from Twilio (auth only on api.twilio.com) → sha256 → object
//   storage under system/sms-media/… → Intake session (AI naming applies
//   downstream) → DELETE the media from Twilio.
// The unit of work is exported for tests; the BullMQ wrapper mirrors
// intake/notify-queue.ts.

import { createHash } from 'node:crypto';

import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import IORedis from 'ioredis';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clients,
  persons,
  smsConversations,
  smsLines,
  smsMedia,
  smsMessages,
} from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { createIntakeSessionWithFiles } from '../intake/create-session';
import { isIntakeEnabled } from '../intake/feature-flag';
import { loadFirmTwilioInboxConfig } from '../messaging/sms-resolver';
import { SMS_MEDIA_QUEUE, type SmsMediaJob } from './media-queue';
import { createTwilioClient, type TwilioClient } from './twilio-client';

export const SMS_MEDIA_STORAGE_PREFIX = 'system/sms-media';
const MAX_ATTEMPTS = 5;

export interface SmsMediaConsumerDeps {
  db: Database | null;
  log: Logger;
  storage?: StorageClient | null;
  twilioClient?: (firmId: string) => Promise<TwilioClient | null>;
  /** default: firm_config.intake_enabled */
  intakeEnabled?: (firmId: string) => Promise<boolean>;
  enqueueIntake?: boolean;
  now?: () => Date;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/vcard': 'vcf',
};

function extFor(contentType: string): string {
  return EXT[contentType.toLowerCase()] ?? 'bin';
}

function mediaSidFromUrl(url: string): string | null {
  const m = /\/Media\/(ME[0-9a-fA-F]{32})/.exec(url);
  return m?.[1] ?? null;
}

function messageSidFromUrl(url: string): string | null {
  const m = /\/Messages\/(SM[0-9a-fA-F]{32}|MM[0-9a-fA-F]{32})\//.exec(url);
  return m?.[1] ?? null;
}

export type SmsMediaOutcome =
  | 'stored'
  | 'intake'
  | 'already_done'
  | 'not_found'
  | 'not_configured'
  | 'failed';

export async function processSmsMediaJob(
  deps: SmsMediaConsumerDeps,
  job: SmsMediaJob,
): Promise<SmsMediaOutcome> {
  const { db, log } = deps;
  if (!db) return 'not_configured';
  const now = deps.now ?? ((): Date => new Date());
  const [row] = await db
    .select({
      media: smsMedia,
      message: {
        id: smsMessages.id,
        providerMessageId: smsMessages.providerMessageId,
        body: smsMessages.body,
        fromE164: smsMessages.fromE164,
      },
      conversation: {
        id: smsConversations.id,
        personId: smsConversations.personId,
        clientId: smsConversations.clientId,
        assignedUserId: smsConversations.assignedUserId,
        lineId: smsConversations.lineId,
      },
    })
    .from(smsMedia)
    .innerJoin(smsMessages, eq(smsMessages.id, smsMedia.messageId))
    .innerJoin(smsConversations, eq(smsConversations.id, smsMessages.conversationId))
    .where(eq(smsMedia.id, job.mediaId))
    .limit(1);
  if (!row) return 'not_found';
  const { media, message, conversation } = row;
  if (media.status === 'intake' && media.remoteDeleted) return 'already_done';
  const firmId = media.firmId;

  const cfg = await loadFirmTwilioInboxConfig(db, firmId, log);
  const twilio =
    (deps.twilioClient ? await deps.twilioClient(firmId) : null) ??
    (cfg ? createTwilioClient(cfg, log) : null);
  if (!twilio) return 'not_configured';
  let storage: StorageClient | null = deps.storage ?? null;
  if (!storage) {
    try {
      storage = buildStorageClient(process.env);
    } catch (err) {
      log.warn({ err }, 'sms media: storage unavailable');
      storage = null;
    }
  }
  if (!storage) return 'not_configured';

  const attempt = media.attemptCount + 1;
  const fail = async (err: unknown): Promise<SmsMediaOutcome> => {
    const msg = err instanceof Error ? err.message : String(err);
    // Never regress a 'stored' row back to the pre-fetch snapshot; only the
    // final attempt flips status (to 'failed').
    await db
      .update(smsMedia)
      .set({
        attemptCount: attempt,
        error: msg.slice(0, 500),
        ...(attempt >= MAX_ATTEMPTS ? { status: 'failed' as const } : {}),
        updatedAt: now(),
      })
      .where(eq(smsMedia.id, media.id));
    log.warn({ err, mediaId: media.id, attempt }, 'sms media job failed');
    if (attempt < MAX_ATTEMPTS) throw err instanceof Error ? err : new Error(msg); // BullMQ retry
    return 'failed';
  };

  try {
    // --- fetch + store ---------------------------------------------------
    let storageKey = media.storageKey;
    let contentType = media.contentType ?? 'application/octet-stream';
    let bytes: Buffer | null = null;
    if (!storageKey) {
      const fetched = await twilio.fetchMedia(media.providerMediaUrl ?? '');
      bytes = fetched.bytes;
      contentType = fetched.contentType || contentType;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const sid =
        media.providerMediaSid ?? mediaSidFromUrl(media.providerMediaUrl ?? '') ?? media.id;
      storageKey = `${SMS_MEDIA_STORAGE_PREFIX}/${firmId}/${conversation.id}/${message.id}/${sid}.${extFor(contentType)}`;
      await storage.put(storageKey, bytes, { contentType });
      await db
        .update(smsMedia)
        .set({
          storageKey,
          contentType,
          sizeBytes: bytes.byteLength,
          sha256,
          status: 'stored',
          attemptCount: attempt,
          error: null,
          updatedAt: now(),
        })
        .where(eq(smsMedia.id, media.id));
    }

    // --- intake hand-off -------------------------------------------------
    let outcome: SmsMediaOutcome = 'stored';
    const wantIntake = deps.intakeEnabled
      ? await deps.intakeEnabled(firmId)
      : await isIntakeEnabled(db, firmId);
    if (wantIntake && !media.intakeSessionId) {
      if (!bytes) {
        const got = await storage.get(storageKey);
        const chunks: Buffer[] = [];
        for await (const c of got.body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        bytes = Buffer.concat(chunks);
      }
      const targetStaffId =
        conversation.assignedUserId ??
        (await db
          .select({ id: smsLines.defaultAssigneeUserId })
          .from(smsLines)
          .where(eq(smsLines.id, conversation.lineId))
          .limit(1)
          .then((r) => r[0]?.id ?? null)) ??
        (await db
          .select({ id: appUsers.id })
          .from(appUsers)
          .where(eq(appUsers.firmId, firmId))
          .limit(1)
          .then((r) => r[0]?.id ?? null));
      if (targetStaffId) {
        let clientName = `Text from ${message.fromE164}`;
        if (conversation.clientId) {
          const [c] = await db
            .select({ name: clients.name })
            .from(clients)
            .where(eq(clients.id, conversation.clientId))
            .limit(1);
          if (c?.name) clientName = c.name;
        } else if (conversation.personId) {
          const [p] = await db
            .select({ name: persons.fullName })
            .from(persons)
            .where(eq(persons.id, conversation.personId))
            .limit(1);
          if (p?.name) clientName = p.name;
        }
        const sid =
          media.providerMediaSid ?? mediaSidFromUrl(media.providerMediaUrl ?? '') ?? media.id;
        const r = await createIntakeSessionWithFiles(db, storage, {
          firmId,
          targetStaffId,
          clientName,
          clientPhone: message.fromE164,
          message: message.body || null,
          source: 'sms',
          matchedClientId: conversation.clientId,
          files: [
            { filename: `mms-${sid}.${extFor(contentType)}`, mimeType: contentType, body: bytes },
          ],
          enqueue: deps.enqueueIntake,
        });
        if (r.ok) {
          await db
            .update(smsMedia)
            .set({
              intakeSessionId: r.sessionId,
              intakeFileId: r.fileIds[0] ?? null,
              status: 'intake',
              updatedAt: now(),
            })
            .where(eq(smsMedia.id, media.id));
          outcome = 'intake';
        } else if (r.code === 'crypto_locked') {
          // Appliance locked: keep the object, retry the hand-off later.
          throw new Error('intake_crypto_locked');
        } else {
          log.warn({ code: r.code, error: r.error, mediaId: media.id }, 'sms media intake failed');
        }
      }
    } else if (media.intakeSessionId) {
      outcome = 'intake';
    }

    // --- delete from Twilio (D7) ------------------------------------------
    if (!media.remoteDeleted) {
      const msgSid = message.providerMessageId ?? messageSidFromUrl(media.providerMediaUrl ?? '');
      const mediaSid = media.providerMediaSid ?? mediaSidFromUrl(media.providerMediaUrl ?? '');
      if (msgSid && mediaSid) {
        try {
          await twilio.deleteMedia(msgSid, mediaSid);
          await db
            .update(smsMedia)
            .set({ remoteDeleted: true, updatedAt: now() })
            .where(eq(smsMedia.id, media.id));
        } catch (err) {
          // Stored locally already — the poll tick retries deletes.
          log.warn({ err, mediaId: media.id }, 'sms media remote delete failed; will retry');
        }
      }
    }
    return outcome;
  } catch (err) {
    return fail(err);
  }
}

export function startSmsMediaConsumer(deps: SmsMediaConsumerDeps): Worker<SmsMediaJob> | null {
  const url = process.env['REDIS_URL'] ?? null;
  if (!url || process.env['SMS_MEDIA_CONSUMER'] === '0' || process.env['NODE_ENV'] === 'test') {
    return null;
  }
  const connection = new IORedis(url, { maxRetriesPerRequest: null });
  const worker = new Worker<SmsMediaJob>(
    SMS_MEDIA_QUEUE,
    async (job: Job<SmsMediaJob>) => {
      const outcome = await processSmsMediaJob(deps, job.data);
      deps.log.info({ mediaId: job.data.mediaId, outcome }, 'sms-media job done');
    },
    { connection, concurrency: 2 },
  );
  worker.on('failed', (job, err) => {
    deps.log.warn({ err, mediaId: job?.data.mediaId }, 'sms-media job failed');
  });
  deps.log.info({ queue: SMS_MEDIA_QUEUE }, 'sms-media consumer started');
  return worker;
}
