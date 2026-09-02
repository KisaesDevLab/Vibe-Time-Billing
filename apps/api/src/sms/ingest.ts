// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Inbound SMS/MMS ingestion (addendum Phase 4). One idempotent function
// shared by the signed webhook, the polling reconciler, and the legacy
// appointment webhook alias. Zod-free: the worker runs it too.
//
//   dedupe on MessageSid → line lookup (auto-discover) → conversation
//   upsert (+unread, reopen) → message insert → association → consent →
//   STOP/START → Communications timeline → media jobs → hooks (PII,
//   reminder replies) → staff notifications (D13a) → health → events

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { normalizePhone } from '@vibe/core/auth';
import type { Database } from '@vibe/db';
import {
  clientCommunications,
  firmSettings,
  firms,
  persons,
  smsConversations,
  smsLines,
  smsMedia,
  smsMessages,
  type SmsRedactionFlag,
} from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { associateConversation } from './associate';
import { mergeSmsHealth } from './health';
import { findPersonsByE164 } from './lookup';
import { insertSmsNotifications, resolveInboundRecipients } from './notify';
import type { SmsEvent } from './send-service';

export interface InboundSms {
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  media: Array<{ url: string; contentType: string; sid?: string }>;
  optOutType?: string | null;
  providerStatus?: string;
  providerTimestamp?: Date | null;
}

export interface IngestHooks {
  /** Phase 11 — PII pattern flags for the stored body. */
  detectPii?: (body: string) => SmsRedactionFlag[];
  /**
   * Phase 12 — appointment reply parsing. Runs after the row exists;
   * return `handled: true` to mark the message read (no unread bump kept)
   * and suppress the generic "new text" notification.
   */
  onInbound?: (ctx: {
    db: Database;
    firmId: string;
    conversationId: string;
    messageId: string;
    from: string;
    body: string;
    personId: string | null;
    clientContactId: string | null;
  }) => Promise<{ handled: boolean; markRead?: boolean } | void>;
}

export interface IngestDeps extends IngestHooks {
  db: Database;
  log: Logger;
  now?: () => Date;
  publish?: (evt: SmsEvent) => Promise<void> | void;
  enqueueMedia?: (job: { mediaId: string; firmId: string }) => Promise<void>;
}

export type IngestResult =
  | {
      status: 'created';
      messageId: string;
      conversationId: string;
      firmId: string;
      personId: string | null;
      clientId: string | null;
      optOut: 'stop' | 'start' | null;
    }
  | { status: 'duplicate'; messageId: string; conversationId: string; firmId: string }
  | { status: 'ignored'; reason: 'line_not_ingesting' | 'invalid_number' }
  | { status: 'no_line' };

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

export function parseOptOut(body: string, optOutType?: string | null): 'stop' | 'start' | null {
  const t = (optOutType ?? '').toUpperCase();
  if (t === 'STOP') return 'stop';
  if (t === 'START') return 'start';
  const first = body.trim().toUpperCase().split(/\s+/)[0] ?? '';
  if (STOP_WORDS.has(first)) return 'stop';
  // Bare "YES" only counts as START when Twilio says so (it's also a
  // reminder confirmation); the explicit words always do.
  if (first === 'START' || first === 'UNSTOP') return 'start';
  return null;
}

class DuplicateInsert extends Error {}

export async function ingestInboundMessage(
  deps: IngestDeps,
  msg: InboundSms,
  opts: { source: 'webhook' | 'poll' },
): Promise<IngestResult> {
  const { db, log } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const ts = now();

  // 0. dedupe (cheap path before any locking)
  const [dup] = await db
    .select({
      id: smsMessages.id,
      conversationId: smsMessages.conversationId,
      firmId: smsMessages.firmId,
    })
    .from(smsMessages)
    .where(eq(smsMessages.providerMessageId, msg.providerMessageId))
    .limit(1);
  if (dup)
    return {
      status: 'duplicate',
      messageId: dup.id,
      conversationId: dup.conversationId,
      firmId: dup.firmId,
    };

  const from = normalizePhone(msg.from);
  const to = normalizePhone(msg.to);
  if (!from || !to) return { status: 'ignored', reason: 'invalid_number' };

  // 1. line (auto-discover on a single-firm appliance)
  let [line] = await db
    .select({
      id: smsLines.id,
      firmId: smsLines.firmId,
      ingest: smsLines.ingest,
      status: smsLines.status,
      defaultAssigneeUserId: smsLines.defaultAssigneeUserId,
    })
    .from(smsLines)
    .where(eq(smsLines.phoneNumberE164, to))
    .limit(1);
  if (!line) {
    const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
    if (!firm) return { status: 'no_line' };
    const [hasDefault] = await db
      .select({ id: smsLines.id })
      .from(smsLines)
      .where(and(eq(smsLines.firmId, firm.id), eq(smsLines.isDefault, true)))
      .limit(1);
    const [created] = await db
      .insert(smsLines)
      .values({
        firmId: firm.id,
        phoneNumberE164: to,
        label: 'Auto-discovered',
        ingest: true,
        isDefault: !hasDefault,
      })
      .onConflictDoNothing()
      .returning({
        id: smsLines.id,
        firmId: smsLines.firmId,
        ingest: smsLines.ingest,
        status: smsLines.status,
        defaultAssigneeUserId: smsLines.defaultAssigneeUserId,
      });
    if (!created) return { status: 'no_line' };
    line = created;
    await mergeSmsHealth(db, firm.id, 'lines', { autoDiscovered: [to] }).catch(() => undefined);
    log.warn({ to }, 'sms line auto-discovered from inbound; label it in settings');
  }
  if (line.status !== 'ACTIVE' || !line.ingest) {
    return { status: 'ignored', reason: 'line_not_ingesting' };
  }
  const firmId = line.firmId;
  const optOut = parseOptOut(msg.body, msg.optOutType);
  const flags = deps.detectPii ? deps.detectPii(msg.body) : [];

  // 2. conversation upsert + message insert, atomically
  let conversationId: string;
  let messageId: string;
  try {
    ({ conversationId, messageId } = await db.transaction(async (tx) => {
      const [conv] = await tx
        .insert(smsConversations)
        .values({
          firmId,
          lineId: line!.id,
          externalNumberE164: from,
          lastMessageAt: ts,
          lastInboundAt: ts,
          unreadCount: 1,
        })
        .onConflictDoUpdate({
          target: [smsConversations.lineId, smsConversations.externalNumberE164],
          set: {
            lastMessageAt: ts,
            lastInboundAt: ts,
            unreadCount: sql`${smsConversations.unreadCount} + 1`,
            status: sql`CASE WHEN ${smsConversations.status} = 'closed' THEN 'open' ELSE ${smsConversations.status} END`,
            updatedAt: ts,
          },
        })
        .returning({ id: smsConversations.id });
      const inserted = await tx
        .insert(smsMessages)
        .values({
          firmId,
          conversationId: conv!.id,
          direction: 'inbound',
          fromE164: from,
          toE164: to,
          body: msg.body ?? '',
          providerMessageId: msg.providerMessageId,
          providerStatus: 'received',
          numMedia: msg.numMedia,
          contextKind: 'inbound',
          optOutType: msg.optOutType ?? null,
          redactionFlags: flags,
          providerTimestamp: msg.providerTimestamp ?? null,
          ingestSource: opts.source,
          createdAt: ts,
        })
        // partial unique index → the predicate must be repeated for inference
        .onConflictDoNothing({
          target: smsMessages.providerMessageId,
          where: sql`provider_message_id IS NOT NULL`,
        })
        .returning({ id: smsMessages.id });
      if (!inserted[0]) throw new DuplicateInsert(); // roll back the unread bump
      return { conversationId: conv!.id, messageId: inserted[0].id };
    }));
  } catch (err) {
    if (err instanceof DuplicateInsert) {
      const [row] = await db
        .select({ id: smsMessages.id, conversationId: smsMessages.conversationId })
        .from(smsMessages)
        .where(eq(smsMessages.providerMessageId, msg.providerMessageId))
        .limit(1);
      return {
        status: 'duplicate',
        messageId: row!.id,
        conversationId: row!.conversationId,
        firmId,
      };
    }
    throw err;
  }

  // 3. association
  const assoc = await associateConversation(db, { conversationId, now: ts }).catch((err) => {
    log.warn({ err, conversationId }, 'sms association failed');
    return null;
  });
  const personId = assoc?.personId ?? null;
  const clientId = assoc?.clientId ?? null;

  // 4. consent — texting first is consent (D8a); 5. STOP / START
  const affected = personId
    ? [personId]
    : (await findPersonsByE164(db, firmId, from)).map((m) => m.personId);
  if (affected.length > 0) {
    if (optOut === 'stop') {
      await db
        .update(persons)
        .set({ smsOptOut: true, smsOptOutAt: ts, smsOptOutSource: 'inbound_stop', updatedAt: ts })
        .where(and(inArray(persons.id, affected), eq(persons.smsOptOut, false)));
      for (const pid of affected) {
        await emitAudit(db, {
          action: 'UPDATE',
          entityType: 'person',
          entityId: pid,
          after: { smsOptOut: true, smsAction: 'opt_out', source: 'inbound_stop' },
        }).catch(() => undefined);
      }
    } else {
      // START clears an opt-out; any other inbound records consent if absent.
      if (optOut === 'start') {
        await db
          .update(persons)
          .set({ smsOptOut: false, smsOptOutAt: null, smsOptOutSource: null, updatedAt: ts })
          .where(and(inArray(persons.id, affected), eq(persons.smsOptOut, true)));
        for (const pid of affected) {
          await emitAudit(db, {
            action: 'UPDATE',
            entityType: 'person',
            entityId: pid,
            after: { smsOptOut: false, smsAction: 'opt_in', source: 'inbound_start' },
          }).catch(() => undefined);
        }
      }
      await db
        .update(persons)
        .set({ smsConsentAt: ts, smsConsentSource: 'inbound', updatedAt: ts })
        .where(and(inArray(persons.id, affected), sql`${persons.smsConsentAt} IS NULL`));
    }
  }

  // 6. Communications timeline (client known)
  if (clientId && msg.body.trim()) {
    await db
      .insert(clientCommunications)
      .values({
        firmId,
        clientId,
        channel: 'SMS',
        direction: 'INBOUND',
        subject: 'Text message',
        body: msg.body.slice(0, 4000),
        occurredAt: ts,
        relatedEntityType: 'sms_conversation',
        relatedEntityId: conversationId,
      })
      .catch((err: unknown) => log.warn({ err }, 'sms communications row failed'));
  }

  // 7. media rows + jobs
  for (const m of msg.media) {
    const sid = m.sid ?? m.url.split('/').pop() ?? null;
    const [row] = await db
      .insert(smsMedia)
      .values({
        firmId,
        messageId,
        providerMediaSid: sid,
        providerMediaUrl: m.url,
        contentType: m.contentType,
        status: 'pending',
      })
      .onConflictDoNothing()
      .returning({ id: smsMedia.id });
    if (row && deps.enqueueMedia) {
      await deps
        .enqueueMedia({ mediaId: row.id, firmId })
        .catch((err: unknown) => log.warn({ err, mediaId: row.id }, 'sms media enqueue failed'));
    }
  }

  // 8. hooks (reminder replies etc.)
  let handled = false;
  if (deps.onInbound) {
    try {
      const r = await deps.onInbound({
        db,
        firmId,
        conversationId,
        messageId,
        from,
        body: msg.body,
        personId,
        clientContactId: assoc?.clientContactId ?? null,
      });
      if (r?.handled) {
        handled = true;
        if (r.markRead) {
          await db.update(smsMessages).set({ readAt: ts }).where(eq(smsMessages.id, messageId));
          await db
            .update(smsConversations)
            .set({ unreadCount: sql`GREATEST(${smsConversations.unreadCount} - 1, 0)` })
            .where(eq(smsConversations.id, conversationId));
        }
      }
    } catch (err) {
      log.warn({ err, messageId }, 'sms inbound hook failed');
    }
  }

  // 9. staff notifications (D13a) — skipped for STOP (nothing to answer)
  //    and for hook-handled replies.
  if (!handled && optOut !== 'stop') {
    try {
      const [conv] = await db
        .select({ assignedUserId: smsConversations.assignedUserId })
        .from(smsConversations)
        .where(eq(smsConversations.id, conversationId))
        .limit(1);
      const recipients = await resolveInboundRecipients(db, {
        firmId,
        assignedUserId: conv?.assignedUserId ?? null,
        lineDefaultAssigneeId: line.defaultAssigneeUserId,
      });
      let who = from;
      if (personId) {
        const [p] = await db
          .select({ name: persons.fullName })
          .from(persons)
          .where(eq(persons.id, personId))
          .limit(1);
        if (p?.name) who = p.name;
      }
      const preview =
        msg.body.trim() || (msg.numMedia > 0 ? `📎 ${msg.numMedia} attachment(s)` : '');
      await insertSmsNotifications(db, {
        firmId,
        recipients,
        type: 'sms_inbound',
        conversationId,
        title: `Text from ${who}`,
        body: preview.slice(0, 140),
        metadata: { messageId, from },
      });
    } catch (err) {
      log.warn({ err, conversationId }, 'sms inbound notification failed');
    }
  }

  // 10. health + events
  if (opts.source === 'webhook') {
    await db
      .update(firmSettings)
      .set({ smsLastInboundWebhookAt: ts })
      .where(eq(firmSettings.firmId, firmId))
      .catch(() => undefined);
    await mergeSmsHealth(db, firmId, 'webhook', {
      lastInboundAt: ts.toISOString(),
      gapDetectedAt: null,
      missedSincePoll: 0,
    }).catch(() => undefined);
  }
  if (deps.publish) {
    try {
      await deps.publish({
        type: 'sms.message.created',
        firmId,
        conversationId,
        messageId,
        clientId,
      });
      await deps.publish({ type: 'sms.conversation.updated', firmId, conversationId, clientId });
    } catch (err) {
      log.warn({ err }, 'sms event publish failed');
    }
  }
  return { status: 'created', messageId, conversationId, firmId, personId, clientId, optOut };
}
