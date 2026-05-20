// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Taxonomy CRUD endpoints (Phase 5).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { engagementTypes, reasonCodes, serviceLines, workCodes } from '@vibe/db/schema';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface TaxonomyRoutesDeps extends RbacDeps {
  db: Database | null;
}

const ServiceLineSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(['tax', 'audit', 'advisory', 'bookkeeping', 'payroll']),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

const WorkCodeSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().min(1).max(120),
  serviceLineId: z.string().uuid().optional(),
  billableDefault: z.boolean().optional(),
  descriptionTemplate: z.string().max(500).optional(),
});

const EngagementTypeSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  name: z.string().min(1).max(120),
  serviceLineId: z.string().uuid().optional(),
  defaultFeeStructure: z
    .enum([
      'HOURLY',
      'HOURLY_NTE',
      'FIXED_FEE',
      'FIXED_FEE_WITH_MILESTONES',
      'RECURRING_SUBSCRIPTION',
    ])
    .optional(),
});

const ReasonCodeSchema = z.object({
  category: z.enum(['WRITE_DOWN', 'WRITE_UP', 'TRANSFER']),
  label: z.string().min(1).max(120),
});

export function createTaxonomyRouter(deps: TaxonomyRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/service-lines',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(serviceLines)
        .where(eq(serviceLines.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/service-lines',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = ServiceLineSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(serviceLines)
        .values({ firmId, ...parsed.data })
        .returning({ id: serviceLines.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/service-lines/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(serviceLines)
        .set({ status: 'ARCHIVED' })
        .where(and(eq(serviceLines.firmId, firmId), eq(serviceLines.id, req.params['id']!)));
      res.json({ ok: true });
    },
  );

  router.get(
    '/work-codes',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db.select().from(workCodes).where(eq(workCodes.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/work-codes',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = WorkCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(workCodes)
        .values({ firmId, ...parsed.data })
        .returning({ id: workCodes.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/engagement-types',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(engagementTypes)
        .where(eq(engagementTypes.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/engagement-types',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementTypeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(engagementTypes)
        .values({ firmId, ...parsed.data })
        .returning({ id: engagementTypes.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/reason-codes',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db.select().from(reasonCodes).where(eq(reasonCodes.firmId, firmId));
      res.json({ items });
    },
  );

  router.post(
    '/reason-codes',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = ReasonCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const [row] = await deps.db
        .insert(reasonCodes)
        .values({ firmId, ...parsed.data })
        .returning({ id: reasonCodes.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/export',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({
          serviceLines: [],
          workCodes: [],
          engagementTypes: [],
          reasonCodes: [],
        });
        return;
      }
      const [sls, wcs, ets, rcs] = await Promise.all([
        deps.db.select().from(serviceLines).where(eq(serviceLines.firmId, session.firmId)),
        deps.db.select().from(workCodes).where(eq(workCodes.firmId, session.firmId)),
        deps.db.select().from(engagementTypes).where(eq(engagementTypes.firmId, session.firmId)),
        deps.db.select().from(reasonCodes).where(eq(reasonCodes.firmId, session.firmId)),
      ]);
      res.json({
        serviceLines: sls,
        workCodes: wcs,
        engagementTypes: ets,
        reasonCodes: rcs,
        exportedAt: new Date().toISOString(),
      });
    },
  );

  return router;
}
