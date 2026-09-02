// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// SMS inbox retention (addendum D10 / Phase 11). Conversations linked to a
// client follow the client's retention and are never purged here (legal
// hold clients are skipped explicitly). Unassigned conversations purge
// after firm_settings.sms_unassigned_retention_days (default 90); spam and
// closed-unassigned after sms_spam_retention_days (default 30). Media
// objects are deleted from storage before the rows cascade.

import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { firmSettings, smsConversations, smsMedia, smsMessages } from '@vibe/db/schema';
import type { StorageClient } from '@vibe/storage';

export interface SmsRetentionResult {
  firms: number;
  conversationsPurged: number;
  messagesPurged: number;
  mediaDeleted: number;
}

export async function runSmsRetention(
  db: Database,
  storage: StorageClient | null,
  log: Logger,
  now = new Date(),
): Promise<SmsRetentionResult> {
  const result: SmsRetentionResult = {
    firms: 0,
    conversationsPurged: 0,
    messagesPurged: 0,
    mediaDeleted: 0,
  };
  const firms = await db
    .select({
      firmId: firmSettings.firmId,
      unassignedDays: firmSettings.smsUnassignedRetentionDays,
      spamDays: firmSettings.smsSpamRetentionDays,
    })
    .from(firmSettings);
  for (const f of firms) {
    const unassignedCutoff = new Date(now.getTime() - f.unassignedDays * 86_400_000);
    const spamCutoff = new Date(now.getTime() - f.spamDays * 86_400_000);
    // Candidates: unassigned (no client) conversations past their window.
    // Client-linked conversations are never touched (client retention, legal hold).
    const candidates = await db
      .select({ id: smsConversations.id })
      .from(smsConversations)
      .where(
        and(
          eq(smsConversations.firmId, f.firmId),
          isNull(smsConversations.clientId),
          or(
            and(
              eq(smsConversations.status, 'open'),
              lt(
                sql`coalesce(${smsConversations.lastMessageAt}, ${smsConversations.createdAt})`,
                unassignedCutoff,
              ),
            ),
            and(
              inArray(smsConversations.status, ['spam', 'closed']),
              lt(
                sql`coalesce(${smsConversations.lastMessageAt}, ${smsConversations.createdAt})`,
                spamCutoff,
              ),
            ),
          ),
        ),
      )
      .limit(500);
    if (candidates.length === 0) continue;
    result.firms += 1;
    const ids = candidates.map((c) => c.id);
    const media = await db
      .select({ id: smsMedia.id, storageKey: smsMedia.storageKey })
      .from(smsMedia)
      .innerJoin(smsMessages, eq(smsMessages.id, smsMedia.messageId))
      .where(inArray(smsMessages.conversationId, ids));
    for (const m of media) {
      if (!m.storageKey || !storage) continue;
      try {
        await storage.delete(m.storageKey);
        result.mediaDeleted += 1;
      } catch (err) {
        log.warn({ err, mediaId: m.id }, 'sms retention: media delete failed');
      }
    }
    const msgs = await db
      .delete(smsMessages)
      .where(inArray(smsMessages.conversationId, ids))
      .returning({ id: smsMessages.id });
    const convs = await db
      .delete(smsConversations)
      .where(inArray(smsConversations.id, ids))
      .returning({ id: smsConversations.id });
    result.messagesPurged += msgs.length;
    result.conversationsPurged += convs.length;
    log.info(
      { firmId: f.firmId, conversations: convs.length, messages: msgs.length },
      'sms retention purged',
    );
  }
  return result;
}
