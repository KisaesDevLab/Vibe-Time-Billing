// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0146 — staging pipeline for client notifications.
//
// stageStatusNotification() is called (fire-and-forget) by the
// workflow-state transition endpoint after the status update commits.
// It snapshots recipients + per-channel rendered content into ONE
// staged_notification row:
//
//   STAGED    → status PENDING_APPROVAL; waits in the Approvals queue.
//   IMMEDIATE → status SCHEDULED, scheduled_at = now, enqueued at once.
//
// Either way a newer status change supersedes (cancels) any still-unsent
// row for the same engagement, inside the same transaction that inserts
// the replacement — the partial unique index on supersede_key enforces
// the invariant even under races.

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientContacts,
  clients,
  engagementStatusConfig,
  engagements,
  firms,
  notificationTemplates,
  persons,
  stagedNotifications,
} from '@vibe/db/schema';
import {
  renderStatusNotification,
  statusTemplateKind,
  type StatusNotificationChannel,
  type StatusNotificationContext,
} from '@vibe/core/notifications';

import { emitAudit } from '../../auth/audit';
import { logger } from '../../logger';
import { firmScope } from '../templating';
import { cancelStagedSend, enqueueStagedSend } from './queue';

export interface RecipientSnapshot {
  personId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** 0224 — SMS opt-out at staging time (the sender re-checks live). */
  smsOptOut?: boolean;
}

export interface StageStatusNotificationArgs {
  firmId: string;
  engagementId: string;
  clientId: string;
  fromState: string | null;
  toState: string;
  actorAppUserId: string;
  ip: string;
  userAgent: string | null;
  // 0166 — manual reprocess: always queue for approval (PENDING_APPROVAL)
  // even when the status is configured to send IMMEDIATE.
  forceStaged?: boolean;
}

export function statusSupersedeKey(engagementId: string): string {
  return `engagement_status:${engagementId}`;
}

const CHANNEL_SET: ReadonlySet<string> = new Set(['EMAIL', 'SMS', 'PORTAL', 'PRINT', 'CALL']);

export async function stageStatusNotification(
  db: Database,
  args: StageStatusNotificationArgs,
): Promise<{ stagedNotificationId: string | null }> {
  const [cfg] = await db
    .select()
    .from(engagementStatusConfig)
    .where(
      and(
        eq(engagementStatusConfig.firmId, args.firmId),
        eq(engagementStatusConfig.workflowState, args.toState),
      ),
    )
    .limit(1);
  const channels = (cfg?.notifyChannels ?? []).filter((c): c is StatusNotificationChannel =>
    CHANNEL_SET.has(c),
  );
  if (!cfg || !cfg.triggersClientComm || channels.length === 0) {
    return { stagedNotificationId: null };
  }

  // Re-entering the same status (no-op transition) shouldn't re-notify.
  if (args.fromState === args.toState) return { stagedNotificationId: null };

  const [row] = await db
    .select({
      engagementName: engagements.name,
      clientName: clients.name,
      firmName: firms.name,
    })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .innerJoin(firms, eq(firms.id, args.firmId))
    .where(eq(engagements.id, args.engagementId))
    .limit(1);
  if (!row) return { stagedNotificationId: null };

  // Recipient snapshot. BILLING_CONTACT falls back to ALL_CONTACTS
  // resolution when no billing contact is flagged — an empty snapshot
  // would stage a row nobody can receive; the approver still sees and
  // can cancel, but a fallback matches dunning's intent.
  const allContacts = await db
    .select({
      personId: persons.id,
      name: persons.fullName,
      email: persons.email,
      phone: persons.phone,
      // 0206 — prefer the mobile for SMS/voice; person.phone is often a
      // landline (which voice can still reach, so either works as fallback).
      mobile: persons.mobile,
      isBilling: clientContacts.isBilling,
      receiveStatusNotifications: clientContacts.receiveStatusNotifications,
      smsOptOut: persons.smsOptOut,
    })
    .from(clientContacts)
    .innerJoin(persons, eq(persons.id, clientContacts.personId))
    .where(and(eq(clientContacts.clientId, args.clientId), eq(clientContacts.status, 'ACTIVE')));
  // 0166 — a contact opted out of status notifications is never eligible,
  // regardless of the status config's BILLING_CONTACT/ALL_CONTACTS rule.
  const eligible = allContacts.filter((c) => c.receiveStatusNotifications !== false);
  const billing = eligible.filter((c) => c.isBilling);
  const picked =
    cfg.notifyRecipients === 'ALL_CONTACTS' ? eligible : billing.length ? billing : eligible;
  const recipients: RecipientSnapshot[] = picked.map((c) => ({
    personId: c.personId,
    name: c.name,
    email: c.email,
    phone: c.mobile ?? c.phone,
    smsOptOut: c.smsOptOut,
  }));

  // Render snapshot per channel: firm template (enabled) else default.
  const templateKind = statusTemplateKind(args.toState);
  const firmTemplates = await db
    .select()
    .from(notificationTemplates)
    .where(
      and(
        eq(notificationTemplates.firmId, args.firmId),
        eq(notificationTemplates.kind, templateKind),
        inArray(notificationTemplates.channel, channels),
        eq(notificationTemplates.enabled, true),
      ),
    );
  const firmTokens = await firmScope(db, args.firmId);
  const context: StatusNotificationContext = {
    client: { name: row.clientName },
    firm: { ...firmTokens, name: row.firmName },
    engagement: { name: row.engagementName },
    status: {
      label: cfg.label,
      client_label: cfg.clientLabel ?? cfg.label,
      client_description: cfg.clientDescription ?? '',
    },
    today: new Date().toISOString().slice(0, 10),
  };
  const rendered: Record<string, { subject: string | null; body: string }> = {};
  for (const channel of channels) {
    const tpl = firmTemplates.find((t) => t.channel === channel);
    rendered[channel] = renderStatusNotification({
      channel,
      template: tpl ? { subject: tpl.subject ?? undefined, body: tpl.body } : null,
      context,
    });
  }

  const isImmediate = cfg.notifyMode === 'IMMEDIATE' && !args.forceStaged;
  const now = new Date();
  const supersedeKey = statusSupersedeKey(args.engagementId);

  let supersededId: string | null = null;
  let newId = '';
  await db.transaction(async (tx) => {
    const [stale] = await tx
      .update(stagedNotifications)
      .set({
        status: 'CANCELED',
        canceledReason: 'SUPERSEDED',
        updatedAt: now,
      })
      .where(
        and(
          eq(stagedNotifications.supersedeKey, supersedeKey),
          inArray(stagedNotifications.status, ['PENDING_APPROVAL', 'SCHEDULED']),
        ),
      )
      .returning({ id: stagedNotifications.id });
    supersededId = stale?.id ?? null;

    const [inserted] = await tx
      .insert(stagedNotifications)
      .values({
        firmId: args.firmId,
        clientId: args.clientId,
        triggerKind: 'engagement_status',
        entityType: 'engagement',
        entityId: args.engagementId,
        triggerContext: {
          workflowState: args.toState,
          fromState: args.fromState,
          statusLabel: cfg.label,
        },
        supersedeKey,
        mode: cfg.notifyMode,
        status: isImmediate ? 'SCHEDULED' : 'PENDING_APPROVAL',
        channels,
        recipientMode: cfg.notifyRecipients,
        recipients,
        rendered,
        templateKind,
        scheduledAt: isImmediate ? now : null,
        createdBy: args.actorAppUserId,
      })
      .returning({ id: stagedNotifications.id });
    newId = inserted!.id;

    if (supersededId) {
      await emitAudit(
        // reason: tx shares the Database query surface; emitAudit only inserts.
        tx as unknown as Database,
        {
          action: 'UPDATE',
          entityType: 'staged_notification',
          entityId: supersededId,
          actorAppUserId: args.actorAppUserId,
          before: { status: 'PENDING_APPROVAL_OR_SCHEDULED' },
          after: { status: 'CANCELED', canceledReason: 'SUPERSEDED', supersededBy: newId },
          ip: args.ip,
          userAgent: args.userAgent,
        },
      );
    }
    await emitAudit(
      // reason: tx shares the Database query surface; emitAudit only inserts.
      tx as unknown as Database,
      {
        action: 'CREATE',
        entityType: 'staged_notification',
        entityId: newId,
        actorAppUserId: args.actorAppUserId,
        before: null,
        after: {
          status: isImmediate ? 'SCHEDULED' : 'PENDING_APPROVAL',
          triggerKind: 'engagement_status',
          engagementId: args.engagementId,
          workflowState: args.toState,
          channels,
        },
        ip: args.ip,
        userAgent: args.userAgent,
      },
    );
  });

  // Queue ops after commit so a rollback can't strand jobs.
  if (supersededId) await cancelStagedSend(supersededId);
  if (isImmediate) await enqueueStagedSend(newId);

  logger.info(
    { stagedNotificationId: newId, supersededId, mode: cfg.notifyMode, channels },
    'status notification staged',
  );
  return { stagedNotificationId: newId };
}
