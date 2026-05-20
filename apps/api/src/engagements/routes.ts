// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Engagement management (Phase 8).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, engagements } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

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
      const items = await deps.db
        .select()
        .from(engagements)
        .where(inArray(engagements.clientId, ids))
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
      const insertVals = {
        ...parsed.data,
        budgetHours: parsed.data.budgetHours?.toString(),
      };
      const [row] = await deps.db
        .insert(engagements)
        .values(insertVals)
        .returning({ id: engagements.id });
      res.status(201).json({ id: row?.id });
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
      const patch: Record<string, unknown> = { status: parsed.data.status };
      if (parsed.data.status === 'CLOSED' || parsed.data.status === 'ARCHIVED') {
        patch['closedAt'] = new Date();
        patch['closedReason'] = parsed.data.reason ?? null;
      }
      await deps.db.update(engagements).set(patch).where(eq(engagements.id, req.params['id']!));
      res.json({ ok: true });
    },
  );

  return router;
}
