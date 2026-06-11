// SPDX-License-Identifier: Elastic-2.0
//
// 0146 — staff decision routes for staged client notifications.
// Mounted at /api/staff/staged-notifications behind the staff auth
// chain; every endpoint requires notification:approve.
//
//   GET  /            — queue list (?status= PENDING_APPROVAL | SCHEDULED |
//                       FAILED | SENT | CANCELED; default active queue)
//   POST /:id/send-now — approve & dispatch immediately (also = retry)
//   POST /:id/schedule — approve & dispatch at { scheduledAt }
//   POST /:id/cancel   — cancel (logged to client_communication)
//   POST /bulk         — { ids, action: SEND_NOW|SCHEDULE|CANCEL, scheduledAt? }
//
// Decisions only act on actionable rows (PENDING_APPROVAL/SCHEDULED;
// send-now also accepts FAILED as a retry). Bulk skips non-actionable
// ids and reports { processed, skipped }.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clientCommunications,
  clients,
  engagements,
  stagedNotifications,
} from '@vibe/db/schema';

import { emitAudit } from '../../auth/audit';
import { requirePermission, type RbacDeps } from '../../auth/rbac-middleware';
import { addUuidIdGuard } from '../../lib/uuid-guard';
import { logger } from '../../logger';
import { cancelStagedSend, enqueueStagedSend } from './queue';

export interface StagedNotificationRoutesDeps extends RbacDeps {
  db: Database | null;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

type DecideAction = 'SEND_NOW' | 'SCHEDULE' | 'CANCEL';

const ACTIONABLE: Record<DecideAction, string[]> = {
  SEND_NOW: ['PENDING_APPROVAL', 'SCHEDULED', 'FAILED'],
  SCHEDULE: ['PENDING_APPROVAL', 'SCHEDULED'],
  CANCEL: ['PENDING_APPROVAL', 'SCHEDULED'],
};

function parseScheduledAt(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return null;
  return d;
}

export function createStagedNotificationRouter(deps: StagedNotificationRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/',
    requirePermission(deps, 'notification:approve'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const statusParam = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      const allowed = ['PENDING_APPROVAL', 'SCHEDULED', 'SENT', 'CANCELED', 'FAILED'] as const;
      const statuses = allowed.includes(statusParam as (typeof allowed)[number])
        ? // reason: narrowing validated by the includes() guard above.
          [statusParam as (typeof allowed)[number]]
        : (['PENDING_APPROVAL', 'SCHEDULED', 'FAILED'] as const);
      const items = await deps.db
        .select({
          id: stagedNotifications.id,
          clientId: stagedNotifications.clientId,
          clientName: clients.name,
          entityType: stagedNotifications.entityType,
          entityId: stagedNotifications.entityId,
          engagementName: engagements.name,
          triggerKind: stagedNotifications.triggerKind,
          triggerContext: stagedNotifications.triggerContext,
          mode: stagedNotifications.mode,
          status: stagedNotifications.status,
          channels: stagedNotifications.channels,
          recipientMode: stagedNotifications.recipientMode,
          recipients: stagedNotifications.recipients,
          rendered: stagedNotifications.rendered,
          scheduledAt: stagedNotifications.scheduledAt,
          sentAt: stagedNotifications.sentAt,
          canceledReason: stagedNotifications.canceledReason,
          channelResults: stagedNotifications.channelResults,
          errorMessage: stagedNotifications.errorMessage,
          createdAt: stagedNotifications.createdAt,
          createdByName: appUsers.fullName,
        })
        .from(stagedNotifications)
        .innerJoin(clients, eq(clients.id, stagedNotifications.clientId))
        .leftJoin(engagements, eq(engagements.id, stagedNotifications.entityId))
        .leftJoin(appUsers, eq(appUsers.id, stagedNotifications.createdBy))
        .where(
          and(
            eq(stagedNotifications.firmId, session.firmId),
            inArray(stagedNotifications.status, [...statuses]),
          ),
        )
        .orderBy(desc(stagedNotifications.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  // Shared single-row decision. Returns the HTTP status to send.
  async function decide(
    db: Database,
    args: {
      id: string;
      firmId: string;
      appUserId: string;
      action: DecideAction;
      scheduledAt: Date | null;
      ip: string;
      userAgent: string | null;
    },
  ): Promise<'ok' | 'not_found' | 'not_actionable'> {
    const [row] = await db
      .select()
      .from(stagedNotifications)
      .where(and(eq(stagedNotifications.id, args.id), eq(stagedNotifications.firmId, args.firmId)))
      .limit(1);
    if (!row) return 'not_found';
    if (!ACTIONABLE[args.action].includes(row.status)) return 'not_actionable';

    const now = new Date();
    if (args.action === 'CANCEL') {
      await db.transaction(async (tx) => {
        await tx
          .update(stagedNotifications)
          .set({
            status: 'CANCELED',
            canceledReason: 'MANUAL',
            decidedBy: args.appUserId,
            decidedAt: now,
            updatedAt: now,
          })
          .where(eq(stagedNotifications.id, row.id));
        // Requirement: cancellations are visible on the client's
        // communication timeline, not just the audit log.
        const ctx = row.triggerContext as { statusLabel?: string };
        await tx.insert(clientCommunications).values({
          firmId: args.firmId,
          clientId: row.clientId,
          channel: 'NOTE',
          direction: 'INTERNAL',
          subject: 'Staged notification canceled',
          body: `Staged ${row.channels.join('/')} notification (${ctx.statusLabel ?? row.templateKind}) was canceled before sending.`,
          recordedById: args.appUserId,
          relatedEntityType: row.entityType,
          relatedEntityId: row.entityId,
        });
        await emitAudit(
          // reason: tx shares the Database query surface; emitAudit only inserts.
          tx as unknown as Database,
          {
            action: 'UPDATE',
            entityType: 'staged_notification',
            entityId: row.id,
            actorAppUserId: args.appUserId,
            before: { status: row.status },
            after: { status: 'CANCELED', canceledReason: 'MANUAL' },
            ip: args.ip,
            userAgent: args.userAgent,
          },
        );
      });
      await cancelStagedSend(row.id);
      return 'ok';
    }

    const fireAt = args.action === 'SCHEDULE' ? args.scheduledAt! : now;
    await db.transaction(async (tx) => {
      await tx
        .update(stagedNotifications)
        .set({
          status: 'SCHEDULED',
          scheduledAt: fireAt,
          decidedBy: args.appUserId,
          decidedAt: now,
          // A retry of a FAILED row starts clean.
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(stagedNotifications.id, row.id));
      await emitAudit(
        // reason: tx shares the Database query surface; emitAudit only inserts.
        tx as unknown as Database,
        {
          action: 'UPDATE',
          entityType: 'staged_notification',
          entityId: row.id,
          actorAppUserId: args.appUserId,
          before: { status: row.status, scheduledAt: row.scheduledAt },
          after: { status: 'SCHEDULED', scheduledAt: fireAt.toISOString(), action: args.action },
          ip: args.ip,
          userAgent: args.userAgent,
        },
      );
    });
    await enqueueStagedSend(row.id, fireAt);
    return 'ok';
  }

  function singleDecideHandler(action: DecideAction) {
    return async (req: Request, res: Response): Promise<void> => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const scheduledAt =
        action === 'SCHEDULE'
          ? parseScheduledAt((req.body as { scheduledAt?: unknown }).scheduledAt)
          : null;
      if (action === 'SCHEDULE' && !scheduledAt) {
        res.status(400).json({ error: 'invalid_scheduled_at' });
        return;
      }
      const outcome = await decide(deps.db, {
        id: req.params['id']!,
        firmId: session.firmId,
        appUserId: session.appUserId,
        action,
        scheduledAt,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      });
      if (outcome === 'not_found') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (outcome === 'not_actionable') {
        res.status(409).json({ error: 'not_actionable' });
        return;
      }
      res.json({ ok: true });
    };
  }

  router.post(
    '/:id/send-now',
    requirePermission(deps, 'notification:approve'),
    singleDecideHandler('SEND_NOW'),
  );
  router.post(
    '/:id/schedule',
    requirePermission(deps, 'notification:approve'),
    singleDecideHandler('SCHEDULE'),
  );
  router.post(
    '/:id/cancel',
    requirePermission(deps, 'notification:approve'),
    singleDecideHandler('CANCEL'),
  );

  router.post(
    '/bulk',
    requirePermission(deps, 'notification:approve'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, processed: 0, skipped: 0 });
        return;
      }
      const body = req.body as { ids?: unknown; action?: unknown; scheduledAt?: unknown };
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === 'string')
        : [];
      const action = body.action;
      if (
        ids.length === 0 ||
        ids.length > 200 ||
        !(action === 'SEND_NOW' || action === 'SCHEDULE' || action === 'CANCEL')
      ) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const scheduledAt = action === 'SCHEDULE' ? parseScheduledAt(body.scheduledAt) : null;
      if (action === 'SCHEDULE' && !scheduledAt) {
        res.status(400).json({ error: 'invalid_scheduled_at' });
        return;
      }
      let processed = 0;
      let skipped = 0;
      for (const id of ids) {
        const outcome = await decide(deps.db, {
          id,
          firmId: session.firmId,
          appUserId: session.appUserId,
          action,
          scheduledAt,
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => {
          logger.error({ err, id }, 'bulk staged-notification decide failed');
          return 'not_actionable' as const;
        });
        if (outcome === 'ok') processed++;
        else skipped++;
      }
      res.json({ ok: true, processed, skipped });
    },
  );

  return router;
}
