// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Engagement management (Phase 8).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements, timeEntries } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

export interface EngagementRoutesDeps extends RbacDeps {
  db: Database | null;
}

const EngagementCreateSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(200),
  engagementTypeId: z.string().uuid().optional(),
  feeStructure: z.enum([
    'HOURLY',
    'HOURLY_NTE',
    'FIXED_FEE',
    'FIXED_FEE_WITH_MILESTONES',
    'RECURRING_SUBSCRIPTION',
  ]),
  feeAmountCents: z.number().int().nonnegative().optional(),
  budgetHours: z.number().nonnegative().optional(),
  budgetAmountCents: z.number().int().nonnegative().optional(),
  mixedModeEnabled: z.boolean().optional(),
  inScopeWorkCodeIds: z.array(z.string().uuid()).max(200).optional(),
  nteCapCents: z.number().int().nonnegative().optional(),
  nteCapScope: z.enum(['PERIOD', 'LIFETIME']).optional(),
  feePassthroughEnabled: z.boolean().optional(),
  partnerId: z.string().uuid().optional(),
  managerId: z.string().uuid().optional(),
  scopeDefinition: z.string().max(10_000).optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  autoRolloverEnabled: z.boolean().optional(),
});

const EngagementStatusSchema = z.object({
  status: z.enum(['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED']),
  reason: z.string().max(400).optional(),
});

async function clientBelongsToFirm(
  db: Database,
  firmId: string,
  clientId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

export function createEngagementRouter(deps: EngagementRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      // Scope: only engagements whose client belongs to this firm.
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, firmId));
      const ids = firmClients.map((c) => c.id);
      if (ids.length === 0) {
        res.json({ items: [] });
        return;
      }
      const conds = [inArray(engagements.clientId, ids)];
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      const allowed = ['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'];
      if (status && allowed.includes(status)) {
        conds.push(
          eq(
            engagements.status,
            status as 'PROPOSED' | 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'ARCHIVED',
          ),
        );
      }
      const partnerId = typeof req.query['partnerId'] === 'string' ? req.query['partnerId'] : null;
      if (partnerId) conds.push(eq(engagements.partnerId, partnerId));
      const items = await deps.db
        .select()
        .from(engagements)
        .where(and(...conds))
        .limit(500);
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, parsed.data.clientId))) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const session = req.staffSession!;
      const insertVals = {
        ...parsed.data,
        budgetHours: parsed.data.budgetHours?.toString(),
      };
      const [row] = await deps.db
        .insert(engagements)
        .values(insertVals)
        .returning({ id: engagements.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ engagement: null });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const [client] = await deps.db
        .select({
          id: clients.id,
          name: clients.name,
          partnerInChargeId: clients.partnerInChargeId,
        })
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      res.json({ engagement: eng, client });
    },
  );

  router.post(
    '/bulk-status',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const body = req.body as { ids?: unknown; status?: unknown; reason?: unknown };
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === 'string')
        : [];
      const targetStatus = typeof body.status === 'string' ? body.status : '';
      const allowed = ['PROPOSED', 'ACTIVE', 'PAUSED', 'CLOSED', 'ARCHIVED'] as const;
      if (!ids.length || !(allowed as readonly string[]).includes(targetStatus)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ ok: true, updated: 0 });
        return;
      }
      const reason = typeof body.reason === 'string' ? body.reason : null;
      // Scope: only update engagements whose client belongs to firm.
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, firmId));
      const clientIds = firmClients.map((c) => c.id);
      const patch: Record<string, unknown> = { status: targetStatus };
      if (targetStatus === 'CLOSED' || targetStatus === 'ARCHIVED') {
        patch['closedAt'] = new Date();
        patch['closedReason'] = reason;
      }
      const updated = await deps.db
        .update(engagements)
        .set(patch)
        .where(and(inArray(engagements.id, ids), inArray(engagements.clientId, clientIds)))
        .returning({ id: engagements.id });
      res.json({ ok: true, updated: updated.length });
    },
  );

  router.get(
    '/:id/budget',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ budget: null });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const [tot] = await deps.db
        .select({
          hours: sql<string>`COALESCE(SUM(${timeEntries.hours}), 0)`.as('hours'),
          amountCents: sql<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`.as(
            'amountCents',
          ),
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.engagementId, eng.id),
            inArray(timeEntries.status, ['SUBMITTED', 'LOCKED', 'BILLED']),
          ),
        );
      const actualHours = Number(tot?.hours ?? 0);
      const actualAmountCents = Number(tot?.amountCents ?? 0);
      const budgetHours = eng.budgetHours != null ? Number(eng.budgetHours) : null;
      const budgetAmountCents =
        eng.budgetAmountCents != null ? Number(eng.budgetAmountCents) : null;
      res.json({
        budget: {
          engagementId: eng.id,
          budgetHours,
          budgetAmountCents,
          nteCapCents: eng.nteCapCents != null ? Number(eng.nteCapCents) : null,
          actualHours,
          actualAmountCents,
          hoursUtilizationPct:
            budgetHours && budgetHours > 0 ? (actualHours / budgetHours) * 100 : null,
          amountUtilizationPct:
            budgetAmountCents && budgetAmountCents > 0
              ? (actualAmountCents / budgetAmountCents) * 100
              : null,
        },
      });
    },
  );

  router.post(
    '/:id/clone',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [src] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!src) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, src.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const newName =
        typeof req.body?.name === 'string' && req.body.name.trim()
          ? String(req.body.name).slice(0, 200)
          : `${src.name} (copy)`;
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        closedAt: _closedAt,
        closedReason: _closedReason,
        ...clonable
      } = src as Record<string, unknown> & { id: string };
      void _id;
      void _createdAt;
      void _updatedAt;
      void _closedAt;
      void _closedReason;
      const [row] = await deps.db
        .insert(engagements)
        .values({ ...(clonable as typeof src), name: newName, status: 'PROPOSED' })
        .returning({ id: engagements.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/:id/status',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const session = req.staffSession!;
      // CLOSED transition: refuse if WIP remains (SUBMITTED time entries
      // not yet attached to a billing batch).
      if (parsed.data.status === 'CLOSED') {
        const [open] = await deps.db
          .select({ c: sql<number>`COUNT(*)`.as('c') })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.engagementId, req.params['id']!),
              eq(timeEntries.status, 'SUBMITTED'),
            ),
          );
        const openCount = Number(open?.c ?? 0);
        if (openCount > 0) {
          res.status(409).json({ error: 'unresolved_wip', submittedTimeEntries: openCount });
          return;
        }
      }
      const patch: Record<string, unknown> = { status: parsed.data.status };
      if (parsed.data.status === 'CLOSED' || parsed.data.status === 'ARCHIVED') {
        patch['closedAt'] = new Date();
        patch['closedReason'] = parsed.data.reason ?? null;
      }
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: parsed.data.status, reason: parsed.data.reason },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const parsed = EngagementCreateSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const patch: Record<string, unknown> = { ...parsed.data };
      if (parsed.data.budgetHours != null) {
        patch['budgetHours'] = parsed.data.budgetHours.toString();
      }
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
