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
import {
  adjustments,
  approvalComments,
  approvalRequests,
  approvalRules,
  appUsers,
} from '@vibe/db/schema';

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

  router.post(
    '/:id/delegate',
    requirePermission(deps, 'approval:act'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const toUserId = typeof req.body?.toUserId === 'string' ? req.body.toUserId : null;
      if (!toUserId) {
        res.status(400).json({ error: 'to_user_id_required' });
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
      await deps.db
        .update(approvalRequests)
        .set({ approverId: toUserId })
        .where(eq(approvalRequests.id, request.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'approval_request',
        entityId: request.id,
        actorAppUserId: session.appUserId,
        after: { delegatedTo: toUserId },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.get(
    '/:id/entity',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ entity: null });
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
      if (request.entityType === 'ADJUSTMENT') {
        const [adj] = await deps.db
          .select()
          .from(adjustments)
          .where(eq(adjustments.id, request.entityId))
          .limit(1);
        res.json({ entity: adj ?? null, kind: 'ADJUSTMENT' });
        return;
      }
      res.json({ entity: null, kind: request.entityType });
    },
  );

  router.get(
    '/:id/comments',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(approvalComments)
        .where(eq(approvalComments.requestId, req.params['id']!))
        .orderBy(approvalComments.createdAt);
      res.json({ items });
    },
  );

  router.post(
    '/:id/comments',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const body = typeof req.body?.body === 'string' ? req.body.body.slice(0, 8000) : null;
      if (!body) {
        res.status(400).json({ error: 'body_required' });
        return;
      }
      const [request] = await deps.db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, req.params['id']!))
        .limit(1);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(approvalComments)
        .values({ requestId: request.id, authorId: session.appUserId, body })
        .returning({ id: approvalComments.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.delete(
    '/:id/comments/:commentId',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [c] = await deps.db
        .select({ authorId: approvalComments.authorId })
        .from(approvalComments)
        .where(eq(approvalComments.id, req.params['commentId']!))
        .limit(1);
      if (!c) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (c.authorId !== session.appUserId) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      await deps.db
        .delete(approvalComments)
        .where(eq(approvalComments.id, req.params['commentId']!));
      res.json({ ok: true });
    },
  );

  router.get(
    '/all',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      const allowed = ['PENDING', 'APPROVED', 'REJECTED', 'APPROVED_WITH_EDITS', 'CANCELLED'];
      const conds = [eq(approvalRequests.requesterId, session.appUserId)];
      if (status && allowed.includes(status)) {
        conds.push(
          eq(
            approvalRequests.status,
            status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPROVED_WITH_EDITS' | 'CANCELLED',
          ),
        );
      }
      const items = await deps.db
        .select()
        .from(approvalRequests)
        .where(and(...conds))
        .orderBy(desc(approvalRequests.requestedAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.post(
    '/bulk-decide',
    requirePermission(deps, 'approval:act'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, processed: 0 });
        return;
      }
      const body = req.body as { ids?: unknown; decision?: unknown; comments?: unknown };
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === 'string')
        : [];
      const decision = typeof body.decision === 'string' ? body.decision : '';
      if (
        ids.length === 0 ||
        !(decision === 'APPROVED' || decision === 'REJECTED' || decision === 'APPROVED_WITH_EDITS')
      ) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const comments = typeof body.comments === 'string' ? body.comments : null;
      let processed = 0;
      for (const id of ids) {
        const [request] = await deps.db
          .select()
          .from(approvalRequests)
          .where(eq(approvalRequests.id, id))
          .limit(1);
        if (!request || request.status !== 'PENDING') continue;
        await deps.db.transaction(async (tx) => {
          await tx
            .update(approvalRequests)
            .set({
              status: decision as 'APPROVED' | 'REJECTED' | 'APPROVED_WITH_EDITS',
              approverId: session.appUserId,
              respondedAt: new Date(),
              comments: comments ?? request.comments,
            })
            .where(eq(approvalRequests.id, request.id));
          if (request.entityType === 'ADJUSTMENT' && decision === 'APPROVED') {
            await tx
              .update(adjustments)
              .set({ status: 'APPLIED', approverId: session.appUserId, approvedAt: new Date() })
              .where(eq(adjustments.id, request.entityId));
          } else if (request.entityType === 'ADJUSTMENT' && decision === 'REJECTED') {
            await tx
              .update(adjustments)
              .set({ status: 'REJECTED' })
              .where(eq(adjustments.id, request.entityId));
          }
        });
        processed++;
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'approval_request',
        actorAppUserId: session.appUserId,
        after: { kind: 'bulk_decide', decision, count: processed },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, processed });
    },
  );

  router.get(
    '/rules',
    requirePermission(deps, 'firm:settings:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(approvalRules)
        .where(eq(approvalRules.firmId, session.firmId))
        .orderBy(approvalRules.priority);
      res.json({ items });
    },
  );

  router.post(
    '/rules',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const body = req.body as {
        entityType?: unknown;
        name?: unknown;
        conditionsJson?: unknown;
        approverResolutionJson?: unknown;
        slaHours?: unknown;
        autoEscalateHours?: unknown;
        priority?: unknown;
      };
      const entityType = typeof body.entityType === 'string' ? body.entityType : null;
      const name = typeof body.name === 'string' ? body.name.slice(0, 200) : null;
      const allowed = ['ADJUSTMENT', 'PRE_BILL', 'INVOICE', 'ENGAGEMENT_LETTER', 'RATE_CHANGE'];
      if (!entityType || !allowed.includes(entityType) || !name) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [row] = await deps.db
        .insert(approvalRules)
        .values({
          firmId: session.firmId,
          entityType: entityType as
            | 'ADJUSTMENT'
            | 'PRE_BILL'
            | 'INVOICE'
            | 'ENGAGEMENT_LETTER'
            | 'RATE_CHANGE',
          name,
          conditionsJson: body.conditionsJson ?? {},
          approverResolutionJson: body.approverResolutionJson ?? {},
          slaHours: typeof body.slaHours === 'number' ? body.slaHours : null,
          autoEscalateHours:
            typeof body.autoEscalateHours === 'number' ? body.autoEscalateHours : null,
          priority: typeof body.priority === 'number' ? body.priority : 100,
        })
        .returning({ id: approvalRules.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'approval_rule',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: { entityType, name },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/rules/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'conditionsJson', 'approverResolutionJson']) {
        if (k in body) patch[k] = body[k];
      }
      for (const k of ['slaHours', 'autoEscalateHours', 'priority']) {
        if (typeof body[k] === 'number') patch[k] = body[k];
      }
      if (
        body['status'] === 'ACTIVE' ||
        body['status'] === 'INACTIVE' ||
        body['status'] === 'ARCHIVED'
      ) {
        patch['status'] = body['status'];
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db
        .update(approvalRules)
        .set(patch)
        .where(
          and(eq(approvalRules.id, req.params['id']!), eq(approvalRules.firmId, session.firmId)),
        );
      res.json({ ok: true });
    },
  );

  router.delete(
    '/rules/:id',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(approvalRules)
        .set({ status: 'ARCHIVED' })
        .where(
          and(eq(approvalRules.id, req.params['id']!), eq(approvalRules.firmId, session.firmId)),
        );
      res.json({ ok: true });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
