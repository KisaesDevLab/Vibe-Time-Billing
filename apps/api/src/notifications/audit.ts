// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Connect H.8 — wrap MailProvider / SmsProvider so every send appends
// a notification_log row. Best-effort: a DB write failure logs but
// does not break delivery. Status is 'sent' when the provider returns
// ok, 'failed' otherwise.

import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { notificationLog } from '@vibe/db/schema';

import type { MailMessage, MailProvider } from '../mail/provider';
import type { SmsMessage, SmsProvider } from '../sms/provider';

export interface AuditWrapDeps {
  db: Database | null;
  log: Logger;
  /** Optional firm-id resolver. Returns null for system-wide sends
   *  (magic-link before session, ops alerts). When unset, every row
   *  records firm_id=null. */
  resolveFirmId?: (recipient: string) => Promise<string | null>;
}

/**
 * Wraps a MailProvider. Each `send` call writes a notification_log row
 * to deps.db (best-effort) with status reflecting the provider result.
 * Returns the original ok/messageId/error so callers see no change.
 */
export function wrapMailWithAudit(underlying: MailProvider, deps: AuditWrapDeps): MailProvider {
  return {
    id: underlying.id,
    async send(msg: MailMessage) {
      const result = await underlying.send(msg);
      void writeRow(deps, {
        channel: 'email',
        provider: underlying.id,
        recipient: msg.to,
        subject: msg.subject,
        templateKey: (msg as MailMessage & { templateKey?: string }).templateKey ?? null,
        status: result.ok ? 'sent' : 'failed',
        providerMessageId: result.messageId ?? null,
        errorMessage: result.error ?? null,
      });
      return result;
    },
  };
}

/**
 * Same as wrapMailWithAudit but for the SMS provider abstraction.
 * SMS messages have no subject; recipient is the phone number.
 */
export function wrapSmsWithAudit(underlying: SmsProvider, deps: AuditWrapDeps): SmsProvider {
  return {
    id: underlying.id,
    async send(msg: SmsMessage) {
      const result = await underlying.send(msg);
      void writeRow(deps, {
        channel: 'sms',
        provider: underlying.id,
        recipient: msg.to,
        subject: null,
        templateKey: (msg as SmsMessage & { templateKey?: string }).templateKey ?? null,
        status: result.ok ? 'sent' : 'failed',
        providerMessageId: result.providerMessageId ?? null,
        errorMessage: result.error ?? null,
      });
      return result;
    },
  };
}

interface RowInput {
  channel: 'email' | 'sms';
  provider: string;
  recipient: string;
  subject: string | null;
  templateKey: string | null;
  status: 'sent' | 'failed';
  providerMessageId: string | null;
  errorMessage: string | null;
}

async function writeRow(deps: AuditWrapDeps, row: RowInput): Promise<void> {
  if (!deps.db) return;
  try {
    const firmId = deps.resolveFirmId ? await deps.resolveFirmId(row.recipient) : null;
    await deps.db.insert(notificationLog).values({
      firmId,
      channel: row.channel,
      provider: row.provider,
      templateKey: row.templateKey,
      recipient: row.recipient,
      subject: row.subject,
      status: row.status,
      providerMessageId: row.providerMessageId,
      errorMessage: row.errorMessage,
    });
  } catch (err) {
    deps.log.warn({ err, recipient: row.recipient }, 'notification_log write failed');
  }
}
