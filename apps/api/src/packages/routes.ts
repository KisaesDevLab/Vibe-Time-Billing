// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P03 — Packages staff API (ADDENDUM-PROPOSAL-MODULE.md §P03).
//
// Mounted at /api/staff/packages. A package is one tier of a logical
// Bronze/Silver/Gold offering. The UI groups packages by `name` for
// the side-by-side preview; the schema stores each tier as its own
// row so backwards compatibility with a future package_family
// concept stays cheap.
//
// Endpoints:
//   GET    /                — list (?includeArchived=true to widen,
//                             ?groupByName=true returns
//                             { groups: { name → tiers[] } })
//   GET    /:id             — detail with package_services hydrated
//                             and per-service materialized price
//                             (override OR catalog default).
//   POST   /                — create header
//   PATCH  /:id             — update header fields
//   POST   /:id/archive     — soft delete (archived_at)
//   POST   /:id/restore
//   POST   /:id/duplicate   — clone header + package_services into a
//                             new row (new id, optional new tier_label)
//   POST   /:id/services    — replace the package_services list
//                             atomically (delete + insert with the
//                             supplied entries).

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { packageServices, packages, servicesCatalog } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface PackageRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  name: z.string().min(1).max(240),
  tierLabel: z.string().min(1).max(80).optional(),
  position: z.number().int().min(0).max(99).optional(),
  description: z.string().max(8000).optional(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(240).optional(),
  tierLabel: z.string().min(1).max(80).optional(),
  position: z.number().int().min(0).max(99).optional(),
  description: z.string().max(8000).optional(),
  priceOverrideCents: z.number().int().min(0).max(999_999_999).nullable().optional(),
});

const ServiceEntrySchema = z.object({
  serviceId: z.string().uuid(),
  overridePriceCents: z.number().int().min(0).max(999_999_999).nullable().optional(),
  included: z.boolean().optional(),
  sequence: z.number().int().min(0).max(999).optional(),
});

const ReplaceServicesSchema = z.object({
  entries: z.array(ServiceEntrySchema).max(200),
});

const DuplicateSchema = z.object({
  name: z.string().min(1).max(240).optional(),
  tierLabel: z.string().min(1).max(80).optional(),
  position: z.number().int().min(0).max(99).optional(),
});

export function createPackageRouter(deps: PackageRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'service:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const includeArchived = req.query['includeArchived'] === 'true';
    const conds = [eq(packages.firmId, session.firmId)];
    if (!includeArchived) {
      conds.push(isNull(packages.archivedAt));
    }
    const rows = await deps.db
      .select()
      .from(packages)
      .where(and(...conds))
      .orderBy(asc(packages.name), asc(packages.position));

    // Hydrate price totals per package in one query.
    const ids = rows.map((p) => p.id);
    const serviceMap = new Map<string, number>(); // packageId → total cents
    const includedCount = new Map<string, number>();
    if (ids.length > 0) {
      const joined = await deps.db
        .select({
          packageId: packageServices.packageId,
          overridePriceCents: packageServices.overridePriceCents,
          defaultPriceCents: servicesCatalog.defaultPriceCents,
          included: packageServices.included,
        })
        .from(packageServices)
        .innerJoin(servicesCatalog, eq(servicesCatalog.id, packageServices.serviceId))
        .where(inArray(packageServices.packageId, ids));
      for (const j of joined) {
        if (!j.included) continue;
        const price = j.overridePriceCents ?? j.defaultPriceCents;
        serviceMap.set(j.packageId, (serviceMap.get(j.packageId) ?? 0) + Number(price));
        includedCount.set(j.packageId, (includedCount.get(j.packageId) ?? 0) + 1);
      }
    }

    const items = rows.map((p) => ({
      ...p,
      totalIncludedCents: serviceMap.get(p.id) ?? 0,
      includedServiceCount: includedCount.get(p.id) ?? 0,
    }));

    if (req.query['groupByName'] === 'true') {
      const groups: Record<string, typeof items> = {};
      for (const it of items) {
        (groups[it.name] ??= []).push(it);
      }
      res.json({ groups });
      return;
    }
    res.json({ items });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'service:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [pkg] = await deps.db
        .select()
        .from(packages)
        .where(and(eq(packages.id, req.params['id']!), eq(packages.firmId, session.firmId)))
        .limit(1);
      if (!pkg) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const entries = await deps.db
        .select({
          id: packageServices.id,
          serviceId: packageServices.serviceId,
          overridePriceCents: packageServices.overridePriceCents,
          included: packageServices.included,
          sequence: packageServices.sequence,
          serviceName: servicesCatalog.name,
          serviceCategory: servicesCatalog.category,
          serviceBillingType: servicesCatalog.billingType,
          serviceRecurringInterval: servicesCatalog.recurringInterval,
          serviceDefaultPriceCents: servicesCatalog.defaultPriceCents,
        })
        .from(packageServices)
        .innerJoin(servicesCatalog, eq(servicesCatalog.id, packageServices.serviceId))
        .where(eq(packageServices.packageId, pkg.id))
        .orderBy(asc(packageServices.sequence));
      res.json({ package: pkg, entries });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .insert(packages)
        .values({
          firmId: session.firmId,
          name: parsed.data.name,
          tierLabel: parsed.data.tierLabel ?? 'Standard',
          position: parsed.data.position ?? 0,
          description: parsed.data.description ?? '',
          createdById: session.appUserId,
        })
        .returning({ id: packages.id });
      if (!row) throw new Error('package_insert_failed');
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'package',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: {
          name: parsed.data.name,
          tierLabel: parsed.data.tierLabel ?? 'Standard',
          position: parsed.data.position ?? 0,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row.id });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(packages)
        .where(and(eq(packages.id, req.params['id']!), eq(packages.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name != null) patch['name'] = parsed.data.name;
      if (parsed.data.tierLabel != null) patch['tierLabel'] = parsed.data.tierLabel;
      if (parsed.data.position != null) patch['position'] = parsed.data.position;
      if (parsed.data.description != null) patch['description'] = parsed.data.description;
      if (parsed.data.priceOverrideCents !== undefined)
        patch['priceOverrideCents'] = parsed.data.priceOverrideCents;
      await deps.db.update(packages).set(patch).where(eq(packages.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'package',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: patch,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/archive',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(packages)
        .where(and(eq(packages.id, req.params['id']!), eq(packages.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.archivedAt != null) {
        res.json({ ok: true, alreadyArchived: true });
        return;
      }
      const now = new Date();
      await deps.db
        .update(packages)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(packages.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'package',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { archivedAt: null },
        after: { archivedAt: now.toISOString() },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/restore',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(packages)
        .where(and(eq(packages.id, req.params['id']!), eq(packages.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.archivedAt == null) {
        res.json({ ok: true, alreadyActive: true });
        return;
      }
      await deps.db
        .update(packages)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(packages.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'package',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { archivedAt: row.archivedAt?.toISOString() ?? null },
        after: { archivedAt: null },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/services',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = ReplaceServicesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [pkg] = await deps.db
        .select({ id: packages.id })
        .from(packages)
        .where(and(eq(packages.id, req.params['id']!), eq(packages.firmId, session.firmId)))
        .limit(1);
      if (!pkg) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Verify every serviceId belongs to this firm.
      const seenIds = Array.from(new Set(parsed.data.entries.map((e) => e.serviceId)));
      if (seenIds.length !== parsed.data.entries.length) {
        res.status(400).json({ error: 'duplicate_service_id' });
        return;
      }
      if (seenIds.length > 0) {
        const owned = await deps.db
          .select({ id: servicesCatalog.id })
          .from(servicesCatalog)
          .where(
            and(eq(servicesCatalog.firmId, session.firmId), inArray(servicesCatalog.id, seenIds)),
          );
        if (owned.length !== seenIds.length) {
          res.status(400).json({ error: 'service_not_in_firm' });
          return;
        }
      }
      await deps.db.delete(packageServices).where(eq(packageServices.packageId, pkg.id));
      if (parsed.data.entries.length > 0) {
        await deps.db.insert(packageServices).values(
          parsed.data.entries.map((e, idx) => ({
            packageId: pkg.id,
            serviceId: e.serviceId,
            overridePriceCents: e.overridePriceCents ?? null,
            included: e.included ?? true,
            sequence: e.sequence ?? idx,
          })),
        );
      }
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'package.services',
        entityId: pkg.id,
        actorAppUserId: session.appUserId,
        after: { entries: parsed.data.entries },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, count: parsed.data.entries.length });
    },
  );

  router.post(
    '/:id/duplicate',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = DuplicateSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [source] = await deps.db
        .select()
        .from(packages)
        .where(and(eq(packages.id, req.params['id']!), eq(packages.firmId, session.firmId)))
        .limit(1);
      if (!source) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [clone] = await deps.db
        .insert(packages)
        .values({
          firmId: session.firmId,
          name: parsed.data.name ?? `${source.name} (copy)`,
          tierLabel: parsed.data.tierLabel ?? source.tierLabel,
          position: parsed.data.position ?? source.position + 1,
          description: source.description,
          createdById: session.appUserId,
        })
        .returning({ id: packages.id });
      if (!clone) throw new Error('package_duplicate_failed');
      const sourceEntries = await deps.db
        .select()
        .from(packageServices)
        .where(eq(packageServices.packageId, source.id));
      if (sourceEntries.length > 0) {
        await deps.db.insert(packageServices).values(
          sourceEntries.map((e) => ({
            packageId: clone.id,
            serviceId: e.serviceId,
            overridePriceCents: e.overridePriceCents,
            included: e.included,
            sequence: e.sequence,
          })),
        );
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'package',
        entityId: clone.id,
        actorAppUserId: session.appUserId,
        after: {
          duplicatedFrom: source.id,
          name: parsed.data.name ?? `${source.name} (copy)`,
          tierLabel: parsed.data.tierLabel ?? source.tierLabel,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: clone.id });
    },
  );

  return router;
}
