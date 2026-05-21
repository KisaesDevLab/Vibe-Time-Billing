// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Engagement management (Phase 8).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagementNotes, engagements, timeEntries } from '@vibe/db/schema';
import { desc } from 'drizzle-orm';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function csv(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
      const managerId = typeof req.query['managerId'] === 'string' ? req.query['managerId'] : null;
      if (managerId) conds.push(eq(engagements.managerId, managerId));
      const feeStructure =
        typeof req.query['feeStructure'] === 'string' ? req.query['feeStructure'] : null;
      const allowedFees = [
        'HOURLY',
        'HOURLY_NTE',
        'FIXED_FEE',
        'FIXED_FEE_WITH_MILESTONES',
        'RECURRING_SUBSCRIPTION',
      ];
      if (feeStructure && allowedFees.includes(feeStructure)) {
        conds.push(
          eq(
            engagements.feeStructure,
            feeStructure as
              | 'HOURLY'
              | 'HOURLY_NTE'
              | 'FIXED_FEE'
              | 'FIXED_FEE_WITH_MILESTONES'
              | 'RECURRING_SUBSCRIPTION',
          ),
        );
      }
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

  router.post(
    '/:id/transfer',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const toClientId = typeof req.body?.toClientId === 'string' ? req.body.toClientId : null;
      if (!toClientId) {
        res.status(400).json({ error: 'to_client_id_required' });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!(await clientBelongsToFirm(deps.db, firmId, toClientId))) {
        res.status(404).json({ error: 'target_client_not_found' });
        return;
      }
      await deps.db
        .update(engagements)
        .set({ clientId: toClientId })
        .where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'transfer', fromClientId: eng.clientId, toClientId },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/budget',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = req.body as {
        budgetHours?: unknown;
        budgetAmountCents?: unknown;
        nteCapCents?: unknown;
      };
      const patch: Record<string, unknown> = {};
      if (typeof body.budgetHours === 'number' && body.budgetHours >= 0) {
        patch['budgetHours'] = body.budgetHours.toString();
      }
      if (typeof body.budgetAmountCents === 'number' && body.budgetAmountCents >= 0) {
        patch['budgetAmountCents'] = body.budgetAmountCents;
      }
      if (typeof body.nteCapCents === 'number' && body.nteCapCents >= 0) {
        patch['nteCapCents'] = body.nteCapCents;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, req.params['id']!));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { kind: 'budget_update', ...patch },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
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

  router.get(
    '/export.csv',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.send('id,name,status\n');
        return;
      }
      const firmClients = await deps.db
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(eq(clients.firmId, firmId));
      const clientNameById = new Map(firmClients.map((c) => [c.id, c.name]));
      if (clientNameById.size === 0) {
        res.send('id,name,status\n');
        return;
      }
      const items = await deps.db
        .select()
        .from(engagements)
        .where(inArray(engagements.clientId, Array.from(clientNameById.keys())))
        .limit(10000);
      const header = ['id', 'name', 'clientName', 'status', 'feeStructure', 'startDate', 'endDate'];
      const lines = [header.join(',')];
      for (const e of items) {
        lines.push(
          [
            e.id,
            csv(e.name),
            csv(clientNameById.get(e.clientId) ?? ''),
            e.status,
            e.feeStructure,
            e.startDate ?? '',
            e.endDate ?? '',
          ].join(','),
        );
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="engagements-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
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

  router.get(
    '/:id/notes',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ items: [] });
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
      const items = await deps.db
        .select()
        .from(engagementNotes)
        .where(eq(engagementNotes.engagementId, req.params['id']!))
        .orderBy(desc(engagementNotes.pinned), desc(engagementNotes.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.delete(
    '/:id/notes/:noteId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .delete(engagementNotes)
        .where(
          and(
            eq(engagementNotes.id, req.params['noteId']!),
            eq(engagementNotes.engagementId, req.params['id']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.patch(
    '/:id/notes/:noteId/pin',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const pinned = req.body?.pinned === true;
      await deps.db
        .update(engagementNotes)
        .set({ pinned })
        .where(
          and(
            eq(engagementNotes.id, req.params['noteId']!),
            eq(engagementNotes.engagementId, req.params['id']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/notes',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
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
      const pinned = req.body?.pinned === true;
      const [eng] = await deps.db
        .select({ clientId: engagements.clientId })
        .from(engagements)
        .where(eq(engagements.id, req.params['id']!))
        .limit(1);
      if (!eng || !(await clientBelongsToFirm(deps.db, firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(engagementNotes)
        .values({
          engagementId: req.params['id']!,
          authorId: session.appUserId,
          body,
          pinned,
        })
        .returning({ id: engagementNotes.id });
      res.status(201).json({ id: row?.id });
    },
  );

  // -----------------------------------------------------------------
  // Custom fields PATCH. Replaces the entire customFields jsonb blob.
  // -----------------------------------------------------------------
  router.patch(
    '/:id/custom-fields',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { customFields?: unknown };
      if (!body.customFields || typeof body.customFields !== 'object') {
        res.status(400).json({ error: 'customFields_required' });
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
      await deps.db
        .update(engagements)
        .set({ customFields: body.customFields as Record<string, unknown> })
        .where(eq(engagements.id, eng.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: eng.id,
        actorAppUserId: session.appUserId,
        after: { kind: 'custom_fields', customFields: body.customFields },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // Engagement rollover-now (Phase 8 #22 v2 — partner-driven). Creates
  // a new engagement in PROPOSED status, optionally with the autoRollover
  // price-increase applied, and queues the old one to be CLOSED.
  // -----------------------------------------------------------------
  router.post(
    '/:id/rollover',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
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
      const pct = eng.autoRolloverPriceIncreasePct ? Number(eng.autoRolloverPriceIncreasePct) : 0;
      const newFee =
        eng.feeAmountCents != null
          ? Math.round(Number(eng.feeAmountCents) * (1 + pct / 100))
          : null;
      const [created] = await deps.db
        .insert(engagements)
        .values({
          clientId: eng.clientId,
          engagementTypeId: eng.engagementTypeId,
          name: `${eng.name} (rollover)`,
          feeStructure: eng.feeStructure,
          feeAmountCents: newFee,
          budgetHours: eng.budgetHours,
          budgetAmountCents: eng.budgetAmountCents,
          mixedModeEnabled: eng.mixedModeEnabled,
          inScopeWorkCodeIds: eng.inScopeWorkCodeIds,
          nteCapCents: eng.nteCapCents,
          nteCapScope: eng.nteCapScope,
          feePassthroughEnabled: eng.feePassthroughEnabled,
          partnerId: eng.partnerId,
          managerId: eng.managerId,
          scopeDefinition: eng.scopeDefinition,
          status: 'PROPOSED',
          autoRolloverEnabled: eng.autoRolloverEnabled,
          autoRolloverPriceIncreasePct: eng.autoRolloverPriceIncreasePct,
        })
        .returning({ id: engagements.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement',
        entityId: created?.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'rollover',
          fromEngagementId: eng.id,
          priceIncreasePct: pct,
          newFeeCents: newFee,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.status(201).json({ id: created?.id, priceIncreasePct: pct });
    },
  );

  // -----------------------------------------------------------------
  // Assign-to-team (Phase 8 #10). Sets partnerId + managerId in one
  // call. Either can be null to clear.
  // -----------------------------------------------------------------
  router.post(
    '/:id/assign',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { partnerId?: unknown; managerId?: unknown };
      const partnerId =
        typeof body.partnerId === 'string'
          ? body.partnerId
          : body.partnerId === null
            ? null
            : undefined;
      const managerId =
        typeof body.managerId === 'string'
          ? body.managerId
          : body.managerId === null
            ? null
            : undefined;
      if (partnerId === undefined && managerId === undefined) {
        res.status(400).json({ error: 'no_fields' });
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
      const patch: Record<string, unknown> = {};
      if (partnerId !== undefined) patch['partnerId'] = partnerId;
      if (managerId !== undefined) patch['managerId'] = managerId;
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, eng.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement',
        entityId: eng.id,
        actorAppUserId: session.appUserId,
        before: { partnerId: eng.partnerId, managerId: eng.managerId },
        after: { kind: 'assign', ...patch },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // NTE auto-suggest (Phase 10 #20). Suggests an NTE cap based on
  // the engagement's fee amount and recent realization. Caller can
  // accept by PATCH-ing the engagement with the returned value.
  // -----------------------------------------------------------------
  router.get(
    '/:id/nte-suggest',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ suggestedCapCents: 0 });
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
      // Two heuristics:
      //   1. If fee_amount_cents is set, suggest fee × 1.2 (20% cushion).
      //   2. Otherwise, suggest 1.25 × the trailing-90-day average month
      //      of unbilled standard amount, rounded up to the nearest $500.
      let suggested = 0;
      let basis = 'no_data';
      if (eng.feeAmountCents != null && Number(eng.feeAmountCents) > 0) {
        suggested = Math.round(Number(eng.feeAmountCents) * 1.2);
        basis = 'fee_with_20pct_cushion';
      } else {
        const { timeEntries: te } = await import('@vibe/db/schema');
        const { sql: drz } = await import('drizzle-orm');
        const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
        const [row] = await deps.db
          .select({
            amount: drz<number>`COALESCE(SUM(${te.standardAmountCents}), 0)`,
          })
          .from(te)
          .where(and(eq(te.engagementId, eng.id), drz`${te.entryDate} >= ${since}::date`));
        const monthlyAvg = Number(row?.amount ?? 0) / 3;
        if (monthlyAvg > 0) {
          suggested = Math.ceil((monthlyAvg * 1.25) / 50000) * 50000;
          basis = 'trailing_90d_avg_x1.25';
        }
      }
      res.json({
        engagementId: eng.id,
        currentCapCents: eng.nteCapCents == null ? null : Number(eng.nteCapCents),
        suggestedCapCents: suggested,
        basis,
      });
    },
  );

  // -----------------------------------------------------------------
  // Cost vs revenue per engagement. Cost is sum(hours × timekeeper.cost_rate)
  // for entries on this engagement; revenue is sum(invoice paid_cents)
  // attributed to this engagement as the primary engagement.
  // -----------------------------------------------------------------
  router.get(
    '/:id/cost-vs-revenue',
    requirePermission(deps, 'report:profitability:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ summary: null });
        return;
      }
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
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
      const { timekeeperRates, invoices } = await import('@vibe/db/schema');
      const [cost] = await deps.db
        .select({
          c: sql<number>`
            COALESCE(SUM(${timeEntries.hours}::numeric * COALESCE((
              SELECT ${timekeeperRates.costRateCents}
              FROM ${timekeeperRates}
              WHERE ${timekeeperRates.appUserId} = ${timeEntries.appUserId}
                AND ${timekeeperRates.effectiveStart} <= ${timeEntries.entryDate}
                AND (${timekeeperRates.effectiveEnd} IS NULL OR ${timekeeperRates.effectiveEnd} >= ${timeEntries.entryDate})
              ORDER BY ${timekeeperRates.effectiveStart} DESC
              LIMIT 1
            ), 0)), 0)::bigint
          `,
        })
        .from(timeEntries)
        .where(eq(timeEntries.engagementId, eng.id));
      const [rev] = await deps.db
        .select({
          billed: sql<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
          paid: sql<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.primaryEngagementId, eng.id));
      const costCents = Number(cost?.c ?? 0);
      const billedCents = Number(rev?.billed ?? 0);
      const paidCents = Number(rev?.paid ?? 0);
      res.json({
        summary: {
          engagementId: eng.id,
          costCents,
          billedCents,
          paidCents,
          marginCents: paidCents - costCents,
          marginPct: paidCents > 0 ? ((paidCents - costCents) / paidCents) * 100 : null,
        },
      });
    },
  );

  // -----------------------------------------------------------------
  // Fixed-fee gap (Phase 11 #17). For FIXED_FEE and FIXED_FEE_WITH_*
  // engagements, the gap is (standard_amount_of_time_entries - fee).
  // Positive gap = unbilled work in excess of fee; negative = budget
  // headroom remaining.
  // -----------------------------------------------------------------
  router.get(
    '/:id/fixed-fee-gap',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ gapCents: 0, feeCents: 0, wipCents: 0 });
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
      if (eng.feeAmountCents == null) {
        res.status(409).json({ error: 'no_fee_set', feeStructure: eng.feeStructure });
        return;
      }
      const { timeEntries: te } = await import('@vibe/db/schema');
      const { sql: drz } = await import('drizzle-orm');
      const [wip] = await deps.db
        .select({
          amount: drz<number>`COALESCE(SUM(${te.standardAmountCents}), 0)`,
          hours: drz<string>`COALESCE(SUM(${te.hours}), 0)`,
        })
        .from(te)
        .where(and(eq(te.engagementId, eng.id), eq(te.billableFlag, true)));
      const fee = Number(eng.feeAmountCents);
      const wipCents = Number(wip?.amount ?? 0);
      res.json({
        engagementId: eng.id,
        feeStructure: eng.feeStructure,
        feeCents: fee,
        wipCents,
        wipHours: Number(wip?.hours ?? 0),
        gapCents: wipCents - fee,
      });
    },
  );

  return router;
}
