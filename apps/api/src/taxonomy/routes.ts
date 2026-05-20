// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Taxonomy CRUD endpoints (Phase 5).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { engagementTypes, reasonCodes, serviceLines, workCodes } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

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
      const session = req.staffSession!;
      const [row] = await deps.db
        .insert(serviceLines)
        .values({ firmId, ...parsed.data })
        .returning({ id: serviceLines.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'service_line',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
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
      const session = req.staffSession!;
      await deps.db
        .update(serviceLines)
        .set({ status: 'ARCHIVED' })
        .where(and(eq(serviceLines.firmId, firmId), eq(serviceLines.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'service_line',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'ARCHIVED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
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
      const session = req.staffSession!;
      const [row] = await deps.db
        .insert(workCodes)
        .values({ firmId, ...parsed.data })
        .returning({ id: workCodes.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'work_code',
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
      const session = req.staffSession!;
      const [row] = await deps.db
        .insert(engagementTypes)
        .values({ firmId, ...parsed.data })
        .returning({ id: engagementTypes.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'engagement_type',
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
      const session = req.staffSession!;
      const [row] = await deps.db
        .insert(reasonCodes)
        .values({ firmId, ...parsed.data })
        .returning({ id: reasonCodes.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'reason_code',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: parsed.data,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.patch(
    '/work-codes/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(workCodes)
        .set({ status: 'ARCHIVED' })
        .where(and(eq(workCodes.firmId, firmId), eq(workCodes.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'work_code',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'ARCHIVED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/engagement-types/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(engagementTypes)
        .set({ status: 'ARCHIVED' })
        .where(and(eq(engagementTypes.firmId, firmId), eq(engagementTypes.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'engagement_type',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'ARCHIVED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.patch(
    '/reason-codes/:id/archive',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession!.firmId;
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      await deps.db
        .update(reasonCodes)
        .set({ status: 'ARCHIVED' })
        .where(and(eq(reasonCodes.firmId, firmId), eq(reasonCodes.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'reason_code',
        entityId: req.params['id']!,
        actorAppUserId: session.appUserId,
        after: { status: 'ARCHIVED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
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
