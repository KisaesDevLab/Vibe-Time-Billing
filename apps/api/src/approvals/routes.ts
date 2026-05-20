// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Approval queue endpoints (Phase 18). Lists pending approvals for the
// current user and accepts approve / reject decisions. The actual
// approval rule evaluation happens at adjustment-create time in
// apps/api/src/adjustments/routes.ts; this surface lets approvers act
// on what landed in the queue.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, isNull, or } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { adjustments, approvalRequests, appUsers } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface ApprovalRoutesDeps extends RbacDeps {
  db: Database | null;
}

const DecideSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'APPROVED_WITH_EDITS']),
  comments: z.string().max(1000).optional(),
});

export function createApprovalRouter(deps: ApprovalRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/pending',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const ownership = or(
        eq(approvalRequests.approverId, session.appUserId),
        isNull(approvalRequests.approverId),
      );
      const conds = [eq(approvalRequests.status, 'PENDING')];
      if (ownership) conds.push(ownership);
      const entityType =
        typeof req.query['entityType'] === 'string' ? req.query['entityType'] : null;
      const allowed = [
        'ADJUSTMENT',
        'PRE_BILL',
        'INVOICE',
        'ENGAGEMENT_LETTER',
        'RATE_CHANGE',
      ] as const;
      if (entityType && (allowed as readonly string[]).includes(entityType)) {
        conds.push(eq(approvalRequests.entityType, entityType as (typeof allowed)[number]));
      }
      const rows = await deps.db
        .select({
          id: approvalRequests.id,
          entityType: approvalRequests.entityType,
          entityId: approvalRequests.entityId,
          requesterId: approvalRequests.requesterId,
          requesterName: appUsers.fullName,
          status: approvalRequests.status,
          requestedAt: approvalRequests.requestedAt,
          comments: approvalRequests.comments,
        })
        .from(approvalRequests)
        .innerJoin(appUsers, eq(appUsers.id, approvalRequests.requesterId))
        .where(and(...conds))
        .orderBy(desc(approvalRequests.requestedAt))
        .limit(200);
      res.json({ items: rows });
    },
  );

  router.post(
    '/:id/decide',
    requirePermission(deps, 'approval:act'),
    async (req: Request, res: Response) => {
      const parsed = DecideSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }

      const [request] = await deps.db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.id, req.params['id']!))
        .limit(1);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.status !== 'PENDING') {
        res.status(409).json({ error: 'already_decided', status: request.status });
        return;
      }

      await deps.db.transaction(async (tx) => {
        await tx
          .update(approvalRequests)
          .set({
            status: parsed.data.decision,
            approverId: session.appUserId,
            respondedAt: new Date(),
            comments: parsed.data.comments ?? request.comments,
          })
          .where(eq(approvalRequests.id, request.id));

        // If approving an adjustment, flip its status PENDING_APPROVAL -> APPLIED.
        if (request.entityType === 'ADJUSTMENT' && parsed.data.decision === 'APPROVED') {
          await tx
            .update(adjustments)
            .set({
              status: 'APPLIED',
              approverId: session.appUserId,
              approvedAt: new Date(),
            })
            .where(eq(adjustments.id, request.entityId));
        } else if (request.entityType === 'ADJUSTMENT' && parsed.data.decision === 'REJECTED') {
          await tx
            .update(adjustments)
            .set({ status: 'REJECTED' })
            .where(eq(adjustments.id, request.entityId));
        }
      });

      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'approval_request',
        entityId: request.id,
        actorAppUserId: session.appUserId,
        after: { status: parsed.data.decision, comments: parsed.data.comments },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({ ok: true });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
