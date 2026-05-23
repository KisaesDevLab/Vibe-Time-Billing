// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Approval queue endpoints (Phase 18). Lists pending approvals for the
// current user and accepts approve / reject decisions. The actual
// approval rule evaluation happens at adjustment-create time in
// apps/api/src/adjustments/routes.ts; this surface lets approvers act
// on what landed in the queue.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';

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
import { addUuidIdGuard } from '../lib/uuid-guard';
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
  addUuidIdGuard(router);

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
          currentStep: approvalRequests.currentStep,
          totalSteps: approvalRequests.totalSteps,
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

      // Firm-scope guard: only the requester's firm can act on this
      // request. Inner-join through requester app_user to enforce.
      const [request] = await deps.db
        .select({
          id: approvalRequests.id,
          ruleId: approvalRequests.ruleId,
          entityType: approvalRequests.entityType,
          entityId: approvalRequests.entityId,
          requesterId: approvalRequests.requesterId,
          approverId: approvalRequests.approverId,
          status: approvalRequests.status,
          comments: approvalRequests.comments,
          requestedAt: approvalRequests.requestedAt,
          respondedAt: approvalRequests.respondedAt,
          dueAt: approvalRequests.dueAt,
          currentStep: approvalRequests.currentStep,
          totalSteps: approvalRequests.totalSteps,
          stepsJson: approvalRequests.stepsJson,
        })
        .from(approvalRequests)
        .innerJoin(appUsers, eq(appUsers.id, approvalRequests.requesterId))
        .where(and(eq(approvalRequests.id, req.params['id']!), eq(appUsers.firmId, session.firmId)))
        .limit(1);
      if (!request) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (request.status !== 'PENDING') {
        res.status(409).json({ error: 'already_decided', status: request.status });
        return;
      }

      // Phase 18 #5 — multi-step routing. If APPROVE on an intermediate
      // step, advance to the next step and stay PENDING; only terminal
      // step approvals or any REJECT flip status.
      const isApprove =
        parsed.data.decision === 'APPROVED' || parsed.data.decision === 'APPROVED_WITH_EDITS';
      const nextStep = request.currentStep + 1;
      const advancing = isApprove && nextStep <= request.totalSteps;
      let nextApproverId: string | null = null;
      if (advancing) {
        const steps = Array.isArray(request.stepsJson)
          ? (request.stepsJson as Array<{ approverId?: string }>)
          : [];
        nextApproverId = steps[nextStep - 1]?.approverId ?? null;
      }

      await deps.db.transaction(async (tx) => {
        if (advancing) {
          await tx
            .update(approvalRequests)
            .set({
              currentStep: nextStep,
              approverId: nextApproverId,
              comments: parsed.data.comments ?? request.comments,
              // status stays PENDING
            })
            .where(eq(approvalRequests.id, request.id));
          return;
        }
        await tx
          .update(approvalRequests)
          .set({
            status: parsed.data.decision,
            approverId: session.appUserId,
            respondedAt: new Date(),
            comments: parsed.data.comments ?? request.comments,
          })
          .where(eq(approvalRequests.id, request.id));

        // If approving an adjustment at the last step, flip its status
        // PENDING_APPROVAL -> APPLIED.
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
        after: {
          status: advancing ? 'PENDING' : parsed.data.decision,
          step: advancing ? nextStep : request.currentStep,
          totalSteps: request.totalSteps,
          comments: parsed.data.comments,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({
        ok: true,
        advanced: advancing,
        currentStep: advancing ? nextStep : request.currentStep,
        totalSteps: request.totalSteps,
      });
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
    '/count',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ pending: 0, mine: 0 });
        return;
      }
      const ownership = or(
        eq(approvalRequests.approverId, session.appUserId),
        isNull(approvalRequests.approverId),
      );
      const { sql: drz } = await import('drizzle-orm');
      const [total] = await deps.db
        .select({ c: drz<number>`COUNT(*)`.as('c') })
        .from(approvalRequests)
        .where(eq(approvalRequests.status, 'PENDING'));
      const conds = [eq(approvalRequests.status, 'PENDING')];
      if (ownership) conds.push(ownership);
      const [mine] = await deps.db
        .select({ c: drz<number>`COUNT(*)`.as('c') })
        .from(approvalRequests)
        .where(and(...conds));
      res.json({ pending: Number(total?.c ?? 0), mine: Number(mine?.c ?? 0) });
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

  // -----------------------------------------------------------------
  // Admin: reassign an approval request to a different approver.
  // Phase 21 #18.
  // -----------------------------------------------------------------
  router.post(
    '/:id/reassign',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { approverId?: unknown };
      const newApprover = typeof body.approverId === 'string' ? body.approverId : null;
      if (!newApprover) {
        res.status(400).json({ error: 'approverId_required' });
        return;
      }
      const [scope] = await deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(and(eq(appUsers.id, newApprover), eq(appUsers.firmId, session.firmId)))
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'approver_not_found' });
        return;
      }
      const [prior] = await deps.db
        .select({ id: approvalRequests.id, approverId: approvalRequests.approverId })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, req.params['id']!))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .update(approvalRequests)
        .set({ approverId: newApprover, status: 'PENDING' })
        .where(eq(approvalRequests.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'approval_request',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        before: { approverId: prior.approverId },
        after: { kind: 'reassign', approverId: newApprover },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // Approval queue CSV export. Phase 21 #19.
  // -----------------------------------------------------------------
  router.get(
    '/export.csv',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.send('id,entityType,entityId,status,requesterId,approverId,requestedAt\n');
        return;
      }
      const status = (req.query['status'] ?? '').toString();
      const conds = [
        inArray(
          approvalRequests.requesterId,
          deps.db
            .select({ id: appUsers.id })
            .from(appUsers)
            .where(eq(appUsers.firmId, session.firmId)),
        ),
      ];
      const validStatuses = [
        'PENDING',
        'APPROVED',
        'REJECTED',
        'APPROVED_WITH_EDITS',
        'CANCELLED',
      ] as const;
      type ApprovalStatus = (typeof validStatuses)[number];
      if ((validStatuses as readonly string[]).includes(status)) {
        conds.push(eq(approvalRequests.status, status as ApprovalStatus));
      }
      const rows = await deps.db
        .select()
        .from(approvalRequests)
        .where(and(...conds))
        .orderBy(desc(approvalRequests.requestedAt))
        .limit(20000);
      const header = [
        'id',
        'entityType',
        'entityId',
        'status',
        'requesterId',
        'approverId',
        'ruleId',
        'requestedAt',
        'respondedAt',
        'dueAt',
      ];
      const lines = [header.join(',')];
      for (const r of rows) {
        lines.push(
          [
            r.id,
            r.entityType,
            r.entityId,
            r.status,
            r.requesterId,
            r.approverId ?? '',
            r.ruleId ?? '',
            r.requestedAt instanceof Date ? r.requestedAt.toISOString() : r.requestedAt,
            r.respondedAt instanceof Date ? r.respondedAt.toISOString() : (r.respondedAt ?? ''),
            r.dueAt instanceof Date ? r.dueAt.toISOString() : (r.dueAt ?? ''),
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="approvals-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  // -----------------------------------------------------------------
  // Metrics: approval throughput + SLA breach count over a window.
  // Phase 21 #20.
  // -----------------------------------------------------------------
  router.get(
    '/metrics',
    requirePermission(deps, 'approval:queue:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: null });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '30'), 10) || 30, 7),
        365,
      );
      const since = new Date(Date.now() - days * 86_400_000);
      const firmUsers = deps.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(eq(appUsers.firmId, session.firmId));
      const [counts] = await deps.db
        .select({
          total: sql<number>`COUNT(*)`,
          pending: sql<number>`COUNT(*) FILTER (WHERE ${approvalRequests.status} = 'PENDING')`,
          approved: sql<number>`COUNT(*) FILTER (WHERE ${approvalRequests.status} = 'APPROVED')`,
          rejected: sql<number>`COUNT(*) FILTER (WHERE ${approvalRequests.status} = 'REJECTED')`,
          avgResponseMs: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${approvalRequests.respondedAt} - ${approvalRequests.requestedAt})) * 1000) FILTER (WHERE ${approvalRequests.respondedAt} IS NOT NULL), 0)`,
          slaBreaches: sql<number>`COUNT(*) FILTER (WHERE ${approvalRequests.dueAt} IS NOT NULL AND ${approvalRequests.dueAt} < NOW() AND ${approvalRequests.status} = 'PENDING')`,
        })
        .from(approvalRequests)
        .where(
          and(
            inArray(approvalRequests.requesterId, firmUsers),
            gte(approvalRequests.requestedAt, since),
          ),
        );
      res.json({
        windowDays: days,
        total: Number(counts?.total ?? 0),
        pending: Number(counts?.pending ?? 0),
        approved: Number(counts?.approved ?? 0),
        rejected: Number(counts?.rejected ?? 0),
        avgResponseMs: Number(counts?.avgResponseMs ?? 0),
        slaBreaches: Number(counts?.slaBreaches ?? 0),
      });
    },
  );

  // -----------------------------------------------------------------
  // Dry-run a rule's conditionsJson against a payload — useful for
  // rule authors to verify match before going live. Phase 21 #16.
  // -----------------------------------------------------------------
  router.post(
    '/rules/:id/dry-run',
    requirePermission(deps, 'firm:settings:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ matched: false });
        return;
      }
      const [rule] = await deps.db
        .select()
        .from(approvalRules)
        .where(
          and(eq(approvalRules.id, req.params['id']!), eq(approvalRules.firmId, session.firmId)),
        )
        .limit(1);
      if (!rule) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = req.body as { payload?: unknown };
      const payload =
        body.payload && typeof body.payload === 'object'
          ? (body.payload as Record<string, unknown>)
          : {};
      const conds = (rule.conditionsJson ?? {}) as Record<string, unknown>;
      const matched = Object.entries(conds).every(([k, v]) => {
        const got = payload[k];
        if (Array.isArray(v)) return v.includes(got);
        return v === got;
      });
      res.json({
        ruleId: rule.id,
        ruleName: rule.name,
        matched,
        conditions: conds,
        payload,
      });
    },
  );

  return router;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
