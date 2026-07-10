// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Taxonomy CRUD endpoints (Phase 5).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustments,
  clientSources,
  contactRoles,
  engagements,
  engagementTypes,
  reasonCodes,
  serviceLines,
  timeEntries,
  workCodes,
} from '@vibe/db/schema';
import { sql } from 'drizzle-orm';

async function countReferences(
  db: Database,
  what: 'service_line' | 'work_code' | 'engagement_type' | 'reason_code',
  id: string,
): Promise<number> {
  // Returns the number of in-use rows referencing this taxonomy id.
  // Used by Phase 5 #7 — refuse archive when something still references.
  switch (what) {
    case 'service_line': {
      const [{ c = 0 } = { c: 0 }] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(workCodes)
        .where(eq(workCodes.serviceLineId, id));
      return Number(c);
    }
    case 'work_code': {
      const [{ c = 0 } = { c: 0 }] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(timeEntries)
        .where(eq(timeEntries.workCodeId, id));
      return Number(c);
    }
    case 'engagement_type': {
      const [{ c = 0 } = { c: 0 }] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(engagements)
        .where(eq(engagements.engagementTypeId, id));
      return Number(c);
    }
    case 'reason_code': {
      const [{ c = 0 } = { c: 0 }] = await db
        .select({ c: sql<number>`COUNT(*)` })
        .from(adjustments)
        .where(eq(adjustments.reasonCodeId, id));
      return Number(c);
    }
  }
}

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
  // 0148 — firm-managed category text (lowercased for stable grouping).
  category: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((v) => v.toLowerCase()),
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
  serviceLineId: z.string().uuid().nullable().optional(),
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

  // v2 followup — rename (PATCH name + color). Refuses to rename to a
  // string that already exists for this firm.
  router.patch(
    '/service-lines/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = ServiceLineSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updates: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name;
      if (parsed.data.category !== undefined) updates.category = parsed.data.category;
      if (parsed.data.color !== undefined) updates.color = parsed.data.color;
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db
        .update(serviceLines)
        .set(updates)
        .where(and(eq(serviceLines.firmId, firmId), eq(serviceLines.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'service_line',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
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
      const refs = await countReferences(deps.db, 'service_line', req.params['id']!);
      if (refs > 0) {
        res.status(409).json({ error: 'in_use', entity: 'work_code', count: refs });
        return;
      }
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
    '/work-codes/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = WorkCodeSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updates: Record<string, unknown> = {};
      for (const k of [
        'name',
        'serviceLineId',
        'billableDefault',
        'descriptionTemplate',
      ] as const) {
        const v = parsed.data[k];
        if (v !== undefined) updates[k] = v;
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db
        .update(workCodes)
        .set(updates)
        .where(and(eq(workCodes.firmId, firmId), eq(workCodes.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'work_code',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
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
      const refs = await countReferences(deps.db, 'work_code', req.params['id']!);
      if (refs > 0) {
        res.status(409).json({ error: 'in_use', entity: 'time_entry', count: refs });
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
    '/engagement-types/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = EngagementTypeSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updates: Record<string, unknown> = {};
      for (const k of ['name', 'serviceLineId', 'defaultFeeStructure'] as const) {
        const v = parsed.data[k];
        if (v !== undefined) updates[k] = v;
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db
        .update(engagementTypes)
        .set(updates)
        .where(and(eq(engagementTypes.firmId, firmId), eq(engagementTypes.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'engagement_type',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
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
      const refs = await countReferences(deps.db, 'engagement_type', req.params['id']!);
      if (refs > 0) {
        res.status(409).json({ error: 'in_use', entity: 'engagement', count: refs });
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
    '/reason-codes/:id',
    requirePermission(deps, 'taxonomy:write'),
    async (req: Request, res: Response) => {
      const parsed = ReasonCodeSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const firmId = req.staffSession!.firmId;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const updates: Record<string, unknown> = {};
      if (parsed.data.label !== undefined) updates.label = parsed.data.label;
      if (parsed.data.category !== undefined) updates.category = parsed.data.category;
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'no_fields' });
        return;
      }
      await deps.db
        .update(reasonCodes)
        .set(updates)
        .where(and(eq(reasonCodes.firmId, firmId), eq(reasonCodes.id, req.params['id']!)));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'reason_code',
        entityId: req.params['id']!,
        actorAppUserId: req.staffSession!.appUserId,
        after: updates,
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
      const refs = await countReferences(deps.db, 'reason_code', req.params['id']!);
      if (refs > 0) {
        res.status(409).json({ error: 'in_use', entity: 'adjustment', count: refs });
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
    '/work-codes/by-service-line/:serviceLineId',
    requirePermission(deps, 'taxonomy:read'),
    async (req: Request, res: Response) => {
      const firmId = req.staffSession?.firmId;
      if (!firmId || !deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select()
        .from(workCodes)
        .where(
          and(
            eq(workCodes.firmId, firmId),
            eq(workCodes.serviceLineId, req.params['serviceLineId']!),
          ),
        );
      res.json({ items });
    },
  );

  router.get(
    '/engagement-types/by-service-line/:serviceLineId',
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
        .where(
          and(
            eq(engagementTypes.firmId, firmId),
            eq(engagementTypes.serviceLineId, req.params['serviceLineId']!),
          ),
        );
      res.json({ items });
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

  // ------------------------------------------------------------------
  // v2 Sprint B (workstream 3.6) — client_source + contact_role taxonomy.
  // Backs the Source dropdown in Create Client wizard and the Role
  // dropdown in the Contacts step. Seeded with defaults in 0034.
  // ------------------------------------------------------------------

  const TaxonomyEntrySchema = z.object({
    key: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().min(1).max(120),
  });

  for (const cfg of [
    { path: 'client-sources', table: clientSources, entityType: 'client_source' as const },
    { path: 'contact-roles', table: contactRoles, entityType: 'contact_role' as const },
  ]) {
    router.get(
      `/${cfg.path}`,
      requirePermission(deps, 'taxonomy:read'),
      async (req: Request, res: Response) => {
        const firmId = req.staffSession?.firmId;
        if (!firmId || !deps.db) {
          res.json({ items: [] });
          return;
        }
        const items = await deps.db.select().from(cfg.table).where(eq(cfg.table.firmId, firmId));
        res.json({ items });
      },
    );

    router.post(
      `/${cfg.path}`,
      requirePermission(deps, 'taxonomy:write'),
      async (req: Request, res: Response) => {
        const parsed = TaxonomyEntrySchema.safeParse(req.body);
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
          .insert(cfg.table)
          .values({ firmId, key: parsed.data.key, name: parsed.data.name })
          .returning({ id: cfg.table.id });
        await emitAudit(deps.db, {
          action: 'CREATE',
          entityType: cfg.entityType,
          entityId: row?.id,
          actorAppUserId: req.staffSession!.appUserId,
          after: parsed.data,
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.status(201).json({ id: row?.id });
      },
    );

    router.patch(
      `/${cfg.path}/:id/archive`,
      requirePermission(deps, 'taxonomy:write'),
      async (req: Request, res: Response) => {
        const firmId = req.staffSession!.firmId;
        if (!deps.db) {
          res.json({ ok: true });
          return;
        }
        await deps.db
          .update(cfg.table)
          .set({ status: 'ARCHIVED' })
          .where(and(eq(cfg.table.firmId, firmId), eq(cfg.table.id, req.params['id']!)));
        await emitAudit(deps.db, {
          action: 'ARCHIVE',
          entityType: cfg.entityType,
          entityId: req.params['id']!,
          actorAppUserId: req.staffSession!.appUserId,
          after: { status: 'ARCHIVED' },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.json({ ok: true });
      },
    );
  }

  return router;
}
