// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// SMS inbox polling reconciler (addendum Phase 5, D4). Self-hosted
// appliances are often behind NAT, so the webhook is primary and this tick
// is the mandatory fallback: per ingesting line it lists Twilio messages
// since the line's cursor (with a 5-minute overlap) and runs the same
// idempotent ingest as the webhook. It also
//   • back-fills delivery status for outbound rows stuck in
//     queued/accepted/sending/sent for > 10 minutes,
//   • re-queues failed / undeleted MMS media,
//   • detects a webhook gap (poll found inbound texts the webhook never
//     delivered) and raises one admin notification per day,
//   • refreshes the US A2P 10DLC status every 6 hours.
//
// Cadence: the cron fires every 2 minutes; each firm is polled only when
// sms_poll_interval_minutes has elapsed since its last poll.

import { and, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import {
  appUsers,
  firmSettings,
  persons,
  smsConversations,
  smsLines,
  smsMedia,
  smsMessages,
  staffNotifications,
} from '@vibe/db/schema';

import { emitAudit } from '../../../api/src/auth/audit';
import { userHasPermission } from '../../../api/src/auth/rbac-resolve';
import {
  loadFirmTwilioInboxConfig,
  type FirmTwilioInboxConfig,
} from '../../../api/src/messaging/sms-resolver';
import { mergeSmsHealth } from '../../../api/src/sms/health';
import { ingestInboundMessage, type IngestDeps } from '../../../api/src/sms/ingest';
import type { SmsEvent } from '../../../api/src/sms/send-service';
import { createTwilioClient, type TwilioClient } from '../../../api/src/sms/twilio-client';

export interface SmsPollDeps {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  publish?: (evt: SmsEvent) => Promise<void> | void;
  enqueueMedia?: (job: { mediaId: string; firmId: string }) => Promise<void>;
  /** test seam */
  twilioClient?: (cfg: FirmTwilioInboxConfig) => TwilioClient;
  /** ignore the per-firm interval (manual "run now") */
  force?: boolean;
  /** Phase 11/12 ingest hooks, threaded through */
  ingestHooks?: Pick<IngestDeps, 'detectPii' | 'onInbound'>;
}

export interface SmsPollResult {
  firms: number;
  linesPolled: number;
  inboundImported: number;
  statusReconciled: number;
  mediaRetried: number;
  gapDetected: boolean;
  a2pRefreshed: number;
}

const OVERLAP_MS = 5 * 60_000;
const FIRST_POLL_LOOKBACK_MS = 24 * 3600_000;
const STUCK_AFTER_MS = 10 * 60_000;
const A2P_REFRESH_MS = 6 * 3600_000;
const MEDIA_RETRY_WINDOW_MS = 24 * 3600_000;
const STUCK_STATUSES = ['queued', 'accepted', 'sending', 'sent'] as const;
const OPT_OUT_ERROR_CODE = 21610;

async function reconcileStuckOutbound(
  db: Database,
  log: Logger,
  firmId: string,
  twilio: TwilioClient,
  now: Date,
  publish?: SmsPollDeps['publish'],
): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = await db
    .select({
      id: smsMessages.id,
      sid: smsMessages.providerMessageId,
      conversationId: smsMessages.conversationId,
      status: smsMessages.providerStatus,
    })
    .from(smsMessages)
    .where(
      and(
        eq(smsMessages.firmId, firmId),
        eq(smsMessages.direction, 'outbound'),
        inArray(smsMessages.providerStatus, [...STUCK_STATUSES]),
        isNotNull(smsMessages.providerMessageId),
        lt(smsMessages.createdAt, cutoff),
      ),
    )
    .limit(200);
  let n = 0;
  for (const m of stuck) {
    try {
      const remote = await twilio.getMessage(m.sid!);
      if (!remote.status || remote.status === m.status) continue;
      await db
        .update(smsMessages)
        .set({
          // reason: Twilio's status vocabulary is the column's CHECK list
          providerStatus: remote.status as 'sent',
          providerErrorCode: remote.errorCode,
          providerErrorMessage: remote.errorMessage,
          providerTimestamp: remote.dateSent ?? now,
        })
        .where(eq(smsMessages.id, m.id));
      n += 1;
      if (remote.errorCode === OPT_OUT_ERROR_CODE) {
        const [conv] = await db
          .select({ personId: smsConversations.personId })
          .from(smsConversations)
          .where(eq(smsConversations.id, m.conversationId))
          .limit(1);
        if (conv?.personId) {
          await db
            .update(persons)
            .set({
              smsOptOut: true,
              smsOptOutAt: now,
              smsOptOutSource: 'provider_21610',
              updatedAt: now,
            })
            .where(and(eq(persons.id, conv.personId), eq(persons.smsOptOut, false)));
          await emitAudit(db, {
            action: 'UPDATE',
            entityType: 'person',
            entityId: conv.personId,
            after: { smsOptOut: true, smsAction: 'opt_out', source: 'provider_21610' },
          }).catch(() => undefined);
        }
      }
      if (publish) {
        // Carry the client so the inbox stream's restricted-client filter
        // (`if (evt.clientId && blocked.has(evt.clientId))`) can match.
        const [convForEvent] = await db
          .select({ clientId: smsConversations.clientId })
          .from(smsConversations)
          .where(eq(smsConversations.id, m.conversationId))
          .limit(1);
        await publish({
          type: 'sms.message.status',
          firmId,
          conversationId: m.conversationId,
          messageId: m.id,
          clientId: convForEvent?.clientId ?? null,
        });
      }
    } catch (err) {
      log.warn({ err, sid: m.sid }, 'sms-poll: status reconcile failed');
    }
  }
  return n;
}

async function retryMedia(
  db: Database,
  firmId: string,
  now: Date,
  enqueue?: SmsPollDeps['enqueueMedia'],
): Promise<number> {
  if (!enqueue) return 0;
  const windowStart = new Date(now.getTime() - MEDIA_RETRY_WINDOW_MS);
  const settled = new Date(now.getTime() - STUCK_AFTER_MS);
  const rows = await db
    .select({ id: smsMedia.id, status: smsMedia.status })
    .from(smsMedia)
    .where(
      and(
        eq(smsMedia.firmId, firmId),
        sql`(
          (${smsMedia.status} = 'failed' AND ${smsMedia.updatedAt} > ${windowStart})
          OR (${smsMedia.status} IN ('stored', 'intake') AND ${smsMedia.remoteDeleted} = false AND ${smsMedia.updatedAt} < ${settled})
        )`,
      ),
    )
    .limit(100);
  let n = 0;
  for (const r of rows) {
    if (r.status === 'failed') {
      await db
        .update(smsMedia)
        .set({ status: 'pending', attemptCount: 0, error: null, updatedAt: now })
        .where(eq(smsMedia.id, r.id));
    }
    await enqueue({ mediaId: r.id, firmId });
    n += 1;
  }
  return n;
}

async function notifyWebhookGap(
  db: Database,
  firmId: string,
  now: Date,
  missed: number,
): Promise<void> {
  const dayAgo = new Date(now.getTime() - 24 * 3600_000);
  const [recent] = await db
    .select({ id: staffNotifications.id })
    .from(staffNotifications)
    .where(
      and(
        eq(staffNotifications.firmId, firmId),
        eq(staffNotifications.type, 'sms_webhook_gap'),
        gt(staffNotifications.createdAt, dayAgo),
      ),
    )
    .limit(1);
  if (recent) return;
  const users = await db
    .select({ id: appUsers.id })
    .from(appUsers)
    .where(and(eq(appUsers.firmId, firmId), eq(appUsers.status, 'ACTIVE')));
  const admins: string[] = [];
  for (const u of users) {
    if (await userHasPermission({ db }, u.id, 'firm:settings:write')) admins.push(u.id);
  }
  if (admins.length === 0) return;
  await db.insert(staffNotifications).values(
    admins.map((rid) => ({
      firmId,
      recipientAppUserId: rid,
      type: 'sms_webhook_gap',
      entityType: 'sms_settings',
      entityId: firmId,
      title: 'Twilio webhook is not reaching this appliance',
      body: `Polling imported ${missed} inbound text(s) the webhook never delivered. Check the public URL and tunnel under Admin → SMS inbox.`,
      actionUrl: '/admin/sms-inbox',
    })),
  );
}

export async function runSmsPollTick(
  db: Database,
  log: Logger,
  deps: SmsPollDeps = {},
): Promise<SmsPollResult> {
  const nowFn = deps.now ?? ((): Date => new Date());
  const now = nowFn();
  const result: SmsPollResult = {
    firms: 0,
    linesPolled: 0,
    inboundImported: 0,
    statusReconciled: 0,
    mediaRetried: 0,
    gapDetected: false,
    a2pRefreshed: 0,
  };
  const firmRows = await db
    .select({
      firmId: firmSettings.firmId,
      intervalMinutes: firmSettings.smsPollIntervalMinutes,
      lastPollAt: firmSettings.smsLastPollAt,
      lastInboundWebhookAt: firmSettings.smsLastInboundWebhookAt,
      a2pCheckedAt: firmSettings.smsA2pCheckedAt,
    })
    .from(firmSettings)
    .where(eq(firmSettings.smsInboxEnabled, true));

  for (const firm of firmRows) {
    const due =
      deps.force ||
      !firm.lastPollAt ||
      now.getTime() - firm.lastPollAt.getTime() >= firm.intervalMinutes * 60_000 - 5_000;
    if (!due) continue;
    const cfg = await loadFirmTwilioInboxConfig(db, firm.firmId, log);
    if (!cfg) continue;
    result.firms += 1;
    const twilio = deps.twilioClient
      ? deps.twilioClient(cfg)
      : createTwilioClient({ ...cfg, fetchImpl: deps.fetchImpl }, log);
    const ingestDeps: IngestDeps = {
      db,
      log,
      now: nowFn,
      publish: deps.publish,
      enqueueMedia: deps.enqueueMedia,
      ...(deps.ingestHooks ?? {}),
    };
    let firmImported = 0;
    let oldestImported: Date | null = null;
    let lastError: string | null = null;

    try {
      const lines = await db
        .select()
        .from(smsLines)
        .where(
          and(
            eq(smsLines.firmId, firm.firmId),
            eq(smsLines.status, 'ACTIVE'),
            eq(smsLines.ingest, true),
          ),
        );
      for (const line of lines) {
        result.linesPolled += 1;
        const cursor = line.pollCursorAt ?? new Date(now.getTime() - FIRST_POLL_LOOKBACK_MS);
        const since = new Date(cursor.getTime() - OVERLAP_MS);
        let maxSeen: Date = cursor;
        try {
          for await (const m of twilio.listMessages({
            to: line.phoneNumberE164,
            dateSentAfter: since,
          })) {
            if (m.direction !== 'inbound') continue;
            const sent = m.dateSent ?? m.dateCreated ?? now;
            if (sent > maxSeen) maxSeen = sent;
            let media: Array<{ url: string; contentType: string; sid?: string }> = [];
            if (m.numMedia > 0) {
              try {
                media = (await twilio.listMedia(m.sid)).map((x) => ({
                  url: x.url,
                  contentType: x.contentType,
                  sid: x.sid,
                }));
              } catch (err) {
                log.warn({ err, sid: m.sid }, 'sms-poll: media list failed');
              }
            }
            const r = await ingestInboundMessage(
              ingestDeps,
              {
                providerMessageId: m.sid,
                from: m.from,
                to: m.to,
                body: m.body,
                numMedia: m.numMedia,
                media,
                providerStatus: m.status,
                providerTimestamp: sent,
              },
              { source: 'poll' },
            );
            if (r.status === 'created') {
              firmImported += 1;
              if (!oldestImported || sent < oldestImported) oldestImported = sent;
            }
          }
          await db
            .update(smsLines)
            .set({ pollCursorAt: maxSeen, lastPolledAt: now, updatedAt: now })
            .where(eq(smsLines.id, line.id));
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          log.warn({ err, line: line.phoneNumberE164 }, 'sms-poll: line poll failed');
        }
      }

      result.statusReconciled += await reconcileStuckOutbound(
        db,
        log,
        firm.firmId,
        twilio,
        now,
        deps.publish,
      );
      result.mediaRetried += await retryMedia(db, firm.firmId, now, deps.enqueueMedia);

      if (!firm.a2pCheckedAt || now.getTime() - firm.a2pCheckedAt.getTime() > A2P_REFRESH_MS) {
        const status = await twilio.getA2pStatus(cfg.messagingServiceSid);
        await db
          .update(firmSettings)
          .set({ smsA2pStatus: status, smsA2pCheckedAt: now })
          .where(eq(firmSettings.firmId, firm.firmId));
        result.a2pRefreshed += 1;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn({ err, firmId: firm.firmId }, 'sms-poll: firm poll failed');
    }

    result.inboundImported += firmImported;
    // Gap: poll imported inbound texts and the webhook has not fired since
    // before the oldest of them (or ever).
    let gap = false;
    if (firmImported > 0 && oldestImported) {
      const lastWebhook = firm.lastInboundWebhookAt;
      gap = !lastWebhook || lastWebhook < oldestImported;
    }
    if (gap) {
      result.gapDetected = true;
      await mergeSmsHealth(db, firm.firmId, 'webhook', {
        gapDetectedAt: now.toISOString(),
        missedSincePoll: firmImported,
      }).catch(() => undefined);
      await notifyWebhookGap(db, firm.firmId, now, firmImported).catch((err: unknown) =>
        log.warn({ err }, 'sms-poll: gap notification failed'),
      );
    }
    await db
      .update(firmSettings)
      .set({ smsLastPollAt: now })
      .where(eq(firmSettings.firmId, firm.firmId));
    await mergeSmsHealth(db, firm.firmId, 'poll', {
      lastAt: now.toISOString(),
      lastOk: !lastError,
      lastError,
      linesPolled: result.linesPolled,
    }).catch(() => undefined);
  }
  return result;
}
