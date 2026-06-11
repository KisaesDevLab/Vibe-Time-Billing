// SPDX-License-Identifier: Elastic-2.0
//
// 0146 — staged-notification send. Consumes the delayed
// 'staged-notification-send' queue (producer:
// apps/api/src/notifications/staged/queue.ts).
//
// The row is the contract: recipients + per-channel rendered content
// were snapshotted at staging time, so this job only (1) re-checks
// guards, (2) fans out per channel, (3) records the outcome. Statuses:
//   SENT    — at least one channel dispatched to someone
//   FAILED  — every channel failed (visible in the queue with Retry)
//   CANCELED/STATE_CHANGED_AT_FIRE — the engagement moved on before
//             the scheduled fire; superseded rows are skipped silently.
//
// Per successful channel: a client_communication OUTBOUND row (the
// client timeline requirement) and, for EMAIL/SMS, a notification_log
// row per recipient (technical send audit). PORTAL inserts one
// portal_notification per ACTIVE portal identity with access to the
// client. SMS consent: client_contact phones follow the dunning
// precedent (billing-contact SMS sends without portal-level consent).

import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  auditLog,
  clientCommunications,
  clientPortalAccess,
  clients,
  engagements,
  notificationLog,
  portalNotifications,
  stagedNotifications,
} from '@vibe/db/schema';

import type { Logger } from 'pino';

import type { MailDispatch, SmsDispatch } from '../dispatchers';

export interface StagedNotificationSendDeps {
  sendEmail?: MailDispatch;
  sendSms?: SmsDispatch;
}

export interface StagedNotificationSendPayload {
  stagedNotificationId: string;
}

interface ChannelResult {
  ok: boolean;
  sentTo: string[];
  error?: string;
}

interface RecipientSnapshot {
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
}

type Rendered = Record<string, { subject: string | null; body: string } | undefined>;

export async function runStagedNotificationSend(
  db: Database,
  log: Logger,
  deps: StagedNotificationSendDeps,
  payload: StagedNotificationSendPayload,
): Promise<{ outcome: 'sent' | 'failed' | 'skipped' | 'canceled_at_fire' }> {
  const [row] = await db
    .select()
    .from(stagedNotifications)
    .where(eq(stagedNotifications.id, payload.stagedNotificationId))
    .limit(1);
  // Cancel/supersede races and double-fires resolve here: only a row
  // still in SCHEDULED is sendable.
  if (!row || row.status !== 'SCHEDULED') {
    log.info({ stagedNotificationId: payload.stagedNotificationId }, 'staged send skipped');
    return { outcome: 'skipped' };
  }

  // Fire-time guard: the snapshot must still describe reality.
  if (row.triggerKind === 'engagement_status') {
    const ctx = row.triggerContext as { workflowState?: string };
    const [eng] = await db
      .select({ workflowState: engagements.workflowState, status: engagements.status })
      .from(engagements)
      .where(eq(engagements.id, row.entityId))
      .limit(1);
    const [client] = await db
      .select({ status: clients.status })
      .from(clients)
      .where(eq(clients.id, row.clientId))
      .limit(1);
    const stale =
      !eng ||
      eng.workflowState !== ctx.workflowState ||
      eng.status === 'ARCHIVED' ||
      !client ||
      client.status === 'ARCHIVED';
    if (stale) {
      const now = new Date();
      await db
        .update(stagedNotifications)
        .set({
          status: 'CANCELED',
          canceledReason: 'STATE_CHANGED_AT_FIRE',
          updatedAt: now,
        })
        .where(eq(stagedNotifications.id, row.id));
      await db
        .insert(auditLog)
        .values({
          action: 'UPDATE',
          entityType: 'staged_notification',
          entityId: row.id,
          beforeJson: { status: 'SCHEDULED' },
          afterJson: { status: 'CANCELED', canceledReason: 'STATE_CHANGED_AT_FIRE' },
        })
        .catch((err: unknown) => log.error({ err }, 'audit emit failed'));
      log.info({ stagedNotificationId: row.id }, 'staged send canceled at fire (state changed)');
      return { outcome: 'canceled_at_fire' };
    }
  }

  const recipients = row.recipients as RecipientSnapshot[];
  const rendered = row.rendered as Rendered;
  const results: Record<string, ChannelResult> = {};

  for (const channel of row.channels) {
    if (channel === 'EMAIL') {
      results['EMAIL'] = await sendEmailChannel(db, log, deps, row, recipients, rendered['EMAIL']);
    } else if (channel === 'SMS') {
      results['SMS'] = await sendSmsChannel(db, log, deps, row, recipients, rendered['SMS']);
    } else if (channel === 'PORTAL') {
      results['PORTAL'] = await sendPortalChannel(db, log, row, rendered['PORTAL']);
    }
  }

  // One client_communication row per successful channel (timeline view).
  for (const [channel, result] of Object.entries(results)) {
    if (!result.ok) continue;
    const r = rendered[channel];
    await db
      .insert(clientCommunications)
      .values({
        firmId: row.firmId,
        clientId: row.clientId,
        // reason: channel is constrained to EMAIL/SMS/PORTAL by the row's
        // channels column; all three are in the client_communication enum.
        channel: channel as 'EMAIL' | 'SMS' | 'PORTAL',
        direction: 'OUTBOUND',
        subject: r?.subject ?? null,
        body: r?.body ?? '',
        occurredAt: new Date(),
        relatedEntityType: row.entityType,
        relatedEntityId: row.entityId,
      })
      .catch((err: unknown) => log.error({ err }, 'client_communication insert failed'));
  }

  const anyOk = Object.values(results).some((r) => r.ok);
  const errors = Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([c, r]) => `${c}: ${r.error ?? 'failed'}`);
  const now = new Date();
  await db
    .update(stagedNotifications)
    .set({
      status: anyOk ? 'SENT' : 'FAILED',
      sentAt: anyOk ? now : null,
      channelResults: results,
      errorMessage: errors.length ? errors.join('; ') : null,
      updatedAt: now,
    })
    .where(eq(stagedNotifications.id, row.id));
  await db
    .insert(auditLog)
    .values({
      action: 'UPDATE',
      entityType: 'staged_notification',
      entityId: row.id,
      beforeJson: { status: 'SCHEDULED' },
      afterJson: { status: anyOk ? 'SENT' : 'FAILED', channelResults: results },
    })
    .catch((err: unknown) => log.error({ err }, 'audit emit failed'));

  log.info(
    { stagedNotificationId: row.id, results, outcome: anyOk ? 'sent' : 'failed' },
    'staged notification send complete',
  );
  return { outcome: anyOk ? 'sent' : 'failed' };
}

type StagedRow = typeof stagedNotifications.$inferSelect;

async function sendEmailChannel(
  db: Database,
  log: Logger,
  deps: StagedNotificationSendDeps,
  row: StagedRow,
  recipients: RecipientSnapshot[],
  content: { subject: string | null; body: string } | undefined,
): Promise<ChannelResult> {
  if (!deps.sendEmail) return { ok: false, sentTo: [], error: 'mail_not_configured' };
  if (!content) return { ok: false, sentTo: [], error: 'no_rendered_content' };
  const targets = recipients.filter((r) => r.email);
  if (targets.length === 0) return { ok: false, sentTo: [], error: 'no_recipient_handle' };
  const sentTo: string[] = [];
  let lastError: string | undefined;
  for (const r of targets) {
    try {
      await deps.sendEmail({
        to: r.email!,
        subject: content.subject ?? 'Update from your accounting firm',
        body: content.body,
      });
      sentTo.push(r.email!);
      await logSend(db, log, row, 'email', r.email!, content.subject, null);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'send_failed';
      log.error({ err, stagedNotificationId: row.id, to: r.email }, 'staged email failed');
      await logSend(db, log, row, 'email', r.email!, content.subject, lastError);
    }
  }
  return sentTo.length > 0
    ? { ok: true, sentTo }
    : { ok: false, sentTo: [], error: lastError ?? 'send_failed' };
}

async function sendSmsChannel(
  db: Database,
  log: Logger,
  deps: StagedNotificationSendDeps,
  row: StagedRow,
  recipients: RecipientSnapshot[],
  content: { subject: string | null; body: string } | undefined,
): Promise<ChannelResult> {
  if (!deps.sendSms) return { ok: false, sentTo: [], error: 'sms_not_configured' };
  if (!content) return { ok: false, sentTo: [], error: 'no_rendered_content' };
  const targets = recipients.filter((r) => r.phone);
  if (targets.length === 0) return { ok: false, sentTo: [], error: 'no_recipient_handle' };
  const sentTo: string[] = [];
  let lastError: string | undefined;
  for (const r of targets) {
    try {
      await deps.sendSms({ to: r.phone!, body: content.body });
      sentTo.push(r.phone!);
      await logSend(db, log, row, 'sms', r.phone!, null, null);
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'send_failed';
      log.error({ err, stagedNotificationId: row.id, to: r.phone }, 'staged sms failed');
      await logSend(db, log, row, 'sms', r.phone!, null, lastError);
    }
  }
  return sentTo.length > 0
    ? { ok: true, sentTo }
    : { ok: false, sentTo: [], error: lastError ?? 'send_failed' };
}

async function sendPortalChannel(
  db: Database,
  log: Logger,
  row: StagedRow,
  content: { subject: string | null; body: string } | undefined,
): Promise<ChannelResult> {
  if (!content) return { ok: false, sentTo: [], error: 'no_rendered_content' };
  const identities = await db
    .select({ portalIdentityId: clientPortalAccess.portalIdentityId })
    .from(clientPortalAccess)
    .where(
      and(eq(clientPortalAccess.clientId, row.clientId), eq(clientPortalAccess.status, 'ACTIVE')),
    );
  if (identities.length === 0) return { ok: false, sentTo: [], error: 'no_portal_access' };
  const sentTo: string[] = [];
  for (const ident of identities) {
    try {
      await db.insert(portalNotifications).values({
        firmId: row.firmId,
        clientId: row.clientId,
        portalIdentityId: ident.portalIdentityId,
        type: row.triggerKind.toUpperCase(),
        entityType: row.entityType,
        entityId: row.entityId,
        title: content.subject ?? 'Update from your accounting firm',
        body: content.body || null,
        actionUrl: row.entityType === 'engagement' ? '/engagements' : null,
        metadata: { stagedNotificationId: row.id },
      });
      sentTo.push(ident.portalIdentityId);
    } catch (err) {
      log.error(
        { err, stagedNotificationId: row.id, portalIdentityId: ident.portalIdentityId },
        'portal notification insert failed',
      );
    }
  }
  return sentTo.length > 0
    ? { ok: true, sentTo }
    : { ok: false, sentTo: [], error: 'insert_failed' };
}

async function logSend(
  db: Database,
  log: Logger,
  row: StagedRow,
  channel: 'email' | 'sms',
  recipient: string,
  subject: string | null,
  errorMessage: string | null,
): Promise<void> {
  await db
    .insert(notificationLog)
    .values({
      firmId: row.firmId,
      channel,
      provider: 'worker',
      templateKey: row.templateKind,
      recipient,
      subject,
      status: errorMessage ? 'failed' : 'sent',
      errorMessage,
    })
    .catch((err: unknown) => log.error({ err }, 'notification_log insert failed'));
}
