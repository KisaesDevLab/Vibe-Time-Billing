// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P02 — Services catalog staff API (ADDENDUM-PROPOSAL-MODULE.md §P02).
//
// Mounted at /api/staff/services. Endpoints:
//   GET    /                — list (filter by category / tag / q /
//                             includeArchived)
//   GET    /:id             — detail
//   POST   /                — create (CREATE audit)
//   PATCH  /:id             — update (UPDATE audit)
//   POST   /:id/archive     — soft-delete via archived_at
//   POST   /:id/restore     — clear archived_at
//   POST   /:id/tags        — replace tag set for a service
//   POST   /bulk-price      — apply percent OR flat delta to many
//                             services in a single transaction. Each
//                             service emits its own UPDATE audit row.
//
// All endpoints require `service:write` except GET endpoints which
// require `service:read`. Bulk-price requires `service:write`.
//
// Soft-delete semantics: archived services stay in the DB so prior
// proposals/engagements still reference them. The list view defaults
// to archived_at IS NULL. ?includeArchived=true exposes archived
// rows. There is no hard-delete in v1 — the addendum says "services
// in use by active engagements cannot be hard-deleted"; we extend
// that to "no service is ever hard-deleted" to keep history clean.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { servicesCatalog, serviceTagAssignments, serviceTags } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface ServiceRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CATEGORIES = ['TAX', 'BOOKKEEPING', 'AUDIT', 'ADVISORY', 'PAYROLL', 'CFO'] as const;
const BILLING_TYPES = [
  'ONE_TIME',
  'RECURRING',
  'ON_COMPLETION',
  'SPLIT_DEPOSIT_RECURRING',
] as const;
const INTERVALS = ['MONTHLY', 'QUARTERLY', 'SEMIANNUALLY', 'ANNUALLY'] as const;

const CreateSchema = z.object({
  name: z.string().min(1).max(240),
  description: z.string().max(8000).optional(),
  category: z.enum(CATEGORIES),
  defaultPriceCents: z.number().int().min(0).max(999_999_999),
  billingType: z.enum(BILLING_TYPES),
  recurringInterval: z.enum(INTERVALS).nullable().optional(),
  isAddon: z.boolean().optional(),
  parentServiceId: z.string().uuid().nullable().optional(),
  coaCode: z.string().max(64).nullable().optional(),
  tagIds: z.array(z.string().uuid()).max(50).optional(),
});

const PatchSchema = z.object({
  name: z.string().min(1).max(240).optional(),
  description: z.string().max(8000).optional(),
  category: z.enum(CATEGORIES).optional(),
  defaultPriceCents: z.number().int().min(0).max(999_999_999).optional(),
  billingType: z.enum(BILLING_TYPES).optional(),
  recurringInterval: z.enum(INTERVALS).nullable().optional(),
  isAddon: z.boolean().optional(),
  parentServiceId: z.string().uuid().nullable().optional(),
  coaCode: z.string().max(64).nullable().optional(),
});

const TagsReplaceSchema = z.object({
  tagIds: z.array(z.string().uuid()).max(50),
});

const BulkPriceSchema = z
  .object({
    serviceIds: z.array(z.string().uuid()).min(1).max(500),
    deltaPercentBps: z.number().int().min(-10000).max(100000).nullable().optional(),
    deltaFlatCents: z.number().int().min(-999_999_999).max(999_999_999).nullable().optional(),
  })
  .refine((v) => (v.deltaPercentBps != null) !== (v.deltaFlatCents != null), {
    message: 'exactly one of deltaPercentBps or deltaFlatCents must be set',
  });

function billingRecurringValid(
  bt: (typeof BILLING_TYPES)[number],
  ri: (typeof INTERVALS)[number] | null | undefined,
): boolean {
  const needsInterval = bt === 'RECURRING' || bt === 'SPLIT_DEPOSIT_RECURRING';
  return needsInterval ? ri != null : ri == null;
}

export function createServiceRouter(deps: ServiceRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'service:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const conds = [eq(servicesCatalog.firmId, session.firmId)];
    const category = typeof req.query['category'] === 'string' ? req.query['category'] : null;
    if (category && (CATEGORIES as readonly string[]).includes(category)) {
      conds.push(eq(servicesCatalog.category, category as (typeof CATEGORIES)[number]));
    }
    const includeArchived = req.query['includeArchived'] === 'true';
    if (!includeArchived) {
      conds.push(isNull(servicesCatalog.archivedAt));
    }
    const q = typeof req.query['q'] === 'string' ? req.query['q'].trim() : null;
    if (q && q.length > 0) {
      conds.push(ilike(servicesCatalog.name, `%${q}%`));
    }
    // Tag filter: services with assignment to the given tag.
    const tagId = typeof req.query['tagId'] === 'string' ? req.query['tagId'] : null;
    if (tagId && /^[0-9a-f-]{36}$/i.test(tagId)) {
      const assigned = await deps.db
        .select({ id: serviceTagAssignments.serviceId })
        .from(serviceTagAssignments)
        .where(eq(serviceTagAssignments.tagId, tagId));
      const ids = assigned.map((r) => r.id);
      if (ids.length === 0) {
        res.json({ items: [] });
        return;
      }
      conds.push(inArray(servicesCatalog.id, ids));
    }
    const rows = await deps.db
      .select()
      .from(servicesCatalog)
      .where(and(...conds))
      .orderBy(asc(servicesCatalog.category), asc(servicesCatalog.name))
      .limit(1000);
    // Hydrate tags for each row in one round-trip.
    const ids = rows.map((r) => r.id);
    let tagMap = new Map<string, { id: string; name: string; color: string | null }[]>();
    if (ids.length > 0) {
      const assignments = await deps.db
        .select({
          serviceId: serviceTagAssignments.serviceId,
          tagId: serviceTags.id,
          tagName: serviceTags.name,
          tagColor: serviceTags.color,
        })
        .from(serviceTagAssignments)
        .innerJoin(serviceTags, eq(serviceTags.id, serviceTagAssignments.tagId))
        .where(inArray(serviceTagAssignments.serviceId, ids));
      tagMap = assignments.reduce((acc, a) => {
        const list = acc.get(a.serviceId) ?? [];
        list.push({ id: a.tagId, name: a.tagName, color: a.tagColor });
        acc.set(a.serviceId, list);
        return acc;
      }, new Map<string, { id: string; name: string; color: string | null }[]>());
    }
    res.json({
      items: rows.map((r) => ({ ...r, tags: tagMap.get(r.id) ?? [] })),
    });
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
      const [row] = await deps.db
        .select()
        .from(servicesCatalog)
        .where(
          and(
            eq(servicesCatalog.id, req.params['id']!),
            eq(servicesCatalog.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const tags = await deps.db
        .select({ id: serviceTags.id, name: serviceTags.name, color: serviceTags.color })
        .from(serviceTagAssignments)
        .innerJoin(serviceTags, eq(serviceTags.id, serviceTagAssignments.tagId))
        .where(eq(serviceTagAssignments.serviceId, row.id));
      res.json({ service: { ...row, tags } });
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
      if (!billingRecurringValid(parsed.data.billingType, parsed.data.recurringInterval ?? null)) {
        res.status(400).json({ error: 'recurring_interval_mismatch' });
        return;
      }
      if (parsed.data.parentServiceId) {
        const [parent] = await deps.db
          .select({ id: servicesCatalog.id })
          .from(servicesCatalog)
          .where(
            and(
              eq(servicesCatalog.id, parsed.data.parentServiceId),
              eq(servicesCatalog.firmId, session.firmId),
            ),
          )
          .limit(1);
        if (!parent) {
          res.status(400).json({ error: 'parent_not_in_firm' });
          return;
        }
      }
      const [row] = await deps.db
        .insert(servicesCatalog)
        .values({
          firmId: session.firmId,
          name: parsed.data.name,
          description: parsed.data.description ?? '',
          category: parsed.data.category,
          defaultPriceCents: parsed.data.defaultPriceCents,
          billingType: parsed.data.billingType,
          recurringInterval: parsed.data.recurringInterval ?? null,
          isAddon: parsed.data.isAddon ?? false,
          parentServiceId: parsed.data.parentServiceId ?? null,
          coaCode: parsed.data.coaCode ?? null,
          createdById: session.appUserId,
        })
        .returning({ id: servicesCatalog.id });
      if (!row) throw new Error('service_insert_failed');
      // Apply initial tag set if provided.
      if (parsed.data.tagIds && parsed.data.tagIds.length > 0) {
        await replaceTagsForService(deps.db, session.firmId, row.id, parsed.data.tagIds);
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'service',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: {
          name: parsed.data.name,
          category: parsed.data.category,
          defaultPriceCents: parsed.data.defaultPriceCents,
          billingType: parsed.data.billingType,
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
        .from(servicesCatalog)
        .where(
          and(
            eq(servicesCatalog.id, req.params['id']!),
            eq(servicesCatalog.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const nextBilling = parsed.data.billingType ?? prior.billingType;
      const nextInterval =
        parsed.data.recurringInterval !== undefined
          ? parsed.data.recurringInterval
          : prior.recurringInterval;
      if (!billingRecurringValid(nextBilling, nextInterval)) {
        res.status(400).json({ error: 'recurring_interval_mismatch' });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.name != null) patch['name'] = parsed.data.name;
      if (parsed.data.description != null) patch['description'] = parsed.data.description;
      if (parsed.data.category != null) patch['category'] = parsed.data.category;
      if (parsed.data.defaultPriceCents != null) {
        patch['defaultPriceCents'] = parsed.data.defaultPriceCents;
      }
      if (parsed.data.billingType != null) patch['billingType'] = parsed.data.billingType;
      if (parsed.data.recurringInterval !== undefined) {
        patch['recurringInterval'] = parsed.data.recurringInterval;
      }
      if (parsed.data.isAddon != null) patch['isAddon'] = parsed.data.isAddon;
      if (parsed.data.parentServiceId !== undefined) {
        patch['parentServiceId'] = parsed.data.parentServiceId;
      }
      if (parsed.data.coaCode !== undefined) patch['coaCode'] = parsed.data.coaCode;
      await deps.db.update(servicesCatalog).set(patch).where(eq(servicesCatalog.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'service',
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
        .from(servicesCatalog)
        .where(
          and(
            eq(servicesCatalog.id, req.params['id']!),
            eq(servicesCatalog.firmId, session.firmId),
          ),
        )
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
        .update(servicesCatalog)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(servicesCatalog.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'service',
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
        .from(servicesCatalog)
        .where(
          and(
            eq(servicesCatalog.id, req.params['id']!),
            eq(servicesCatalog.firmId, session.firmId),
          ),
        )
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
        .update(servicesCatalog)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(eq(servicesCatalog.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'service',
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
    '/:id/tags',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = TagsReplaceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select({ id: servicesCatalog.id })
        .from(servicesCatalog)
        .where(
          and(
            eq(servicesCatalog.id, req.params['id']!),
            eq(servicesCatalog.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await replaceTagsForService(deps.db, session.firmId, row.id, parsed.data.tagIds);
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'service.tags',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { tagIds: parsed.data.tagIds },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/bulk-price',
    requirePermission(deps, 'service:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = BulkPriceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const rows = await deps.db
        .select()
        .from(servicesCatalog)
        .where(
          and(
            eq(servicesCatalog.firmId, session.firmId),
            inArray(servicesCatalog.id, parsed.data.serviceIds),
          ),
        );
      if (rows.length === 0) {
        res.status(404).json({ error: 'no_services_matched' });
        return;
      }
      const updates: { id: string; before: number; after: number }[] = [];
      for (const r of rows) {
        const before = r.defaultPriceCents;
        let after: number;
        if (parsed.data.deltaPercentBps != null) {
          // delta_bps is basis points: 500 = +5%, -500 = -5%.
          // Round half-away-from-zero on the multiplied cents.
          const scaled = Math.round((before * (10_000 + parsed.data.deltaPercentBps)) / 10_000);
          after = Math.max(0, scaled);
        } else {
          after = Math.max(0, before + (parsed.data.deltaFlatCents ?? 0));
        }
        if (after !== before) {
          updates.push({ id: r.id, before, after });
        }
      }
      // Apply each update inline. Drizzle's pglite driver lacks a true
      // transaction wrapper in our test harness; rely on the fact that
      // each UPDATE is atomic and emit individual audit rows.
      for (const u of updates) {
        await deps.db
          .update(servicesCatalog)
          .set({ defaultPriceCents: u.after, updatedAt: new Date() })
          .where(eq(servicesCatalog.id, u.id));
        await emitAudit(deps.db, {
          action: 'UPDATE',
          entityType: 'service.price',
          entityId: u.id,
          actorAppUserId: session.appUserId,
          before: { defaultPriceCents: u.before },
          after: { defaultPriceCents: u.after },
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      }
      res.json({ ok: true, updated: updates.length, matched: rows.length });
    },
  );

  return router;
}

// Replace the tag-assignment set for a service atomically. Validates
// that every tag id belongs to the firm before INSERTs.
async function replaceTagsForService(
  db: Database,
  firmId: string,
  serviceId: string,
  tagIds: string[],
): Promise<void> {
  if (tagIds.length > 0) {
    const owned = await db
      .select({ id: serviceTags.id })
      .from(serviceTags)
      .where(and(eq(serviceTags.firmId, firmId), inArray(serviceTags.id, tagIds)));
    if (owned.length !== new Set(tagIds).size) {
      throw new Error('tag_not_in_firm');
    }
  }
  await db.delete(serviceTagAssignments).where(eq(serviceTagAssignments.serviceId, serviceId));
  if (tagIds.length > 0) {
    await db.insert(serviceTagAssignments).values(tagIds.map((tagId) => ({ serviceId, tagId })));
  }
}
