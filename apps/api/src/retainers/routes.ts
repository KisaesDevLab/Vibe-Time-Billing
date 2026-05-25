// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R2 — Staff-facing retainer offer + retainer list/detail endpoints.
//
// Mounted at /api/staff/retainers. R5 will extend this with KPI, void,
// dashboard listing, and preview-split endpoints. For R2 we ship the
// minimum needed for partner visibility into auto-created offers.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { engagements, retainerLedger, retainerOffers, retainers } from '@vibe/db/schema';
import { computeSplit, isEligibleEntry } from '@vibe/core/retainers';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface RetainerRoutesDeps extends RbacDeps {
  db: Database | null;
}

export function createRetainerRouter(deps: RetainerRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ----- offers ------------------------------------------------------

  router.get(
    '/offers',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds = [eq(retainerOffers.firmId, session.firmId)];
      const invoiceFilter = uuidQueryParam(req.query['invoiceId']);
      if (invoiceFilter) conds.push(eq(retainerOffers.invoiceId, invoiceFilter));
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      if (status) {
        conds.push(
          eq(
            retainerOffers.status,
            status as 'pending' | 'pending_payment' | 'purchased' | 'declined' | 'expired',
          ),
        );
      }
      const items = await deps.db
        .select()
        .from(retainerOffers)
        .where(and(...conds))
        .orderBy(desc(retainerOffers.createdAt))
        .limit(200);
      res.json({ items });
    },
  );

  router.get(
    '/offers/:id',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(retainerOffers)
        .where(
          and(eq(retainerOffers.id, req.params['id']!), eq(retainerOffers.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ offer: row });
    },
  );

  // ----- retainers (read-only for R2; full CRUD in R5) --------------

  router.get('/', requirePermission(deps, 'retainer:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(retainers)
      .where(eq(retainers.firmId, session.firmId))
      .orderBy(desc(retainers.createdAt))
      .limit(200);
    res.json({ items });
  });

  router.get(
    '/admin/kpis',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ kpis: null });
        return;
      }
      const [agg] = await deps.db
        .select({
          activeCount: sql<number>`COUNT(*) FILTER (WHERE ${retainers.status} = 'active')`,
          tier1Active: sql<number>`COUNT(*) FILTER (WHERE ${retainers.status} = 'active' AND ${retainers.tier} = 'TIER_1')`,
          tier2Active: sql<number>`COUNT(*) FILTER (WHERE ${retainers.status} = 'active' AND ${retainers.tier} = 'TIER_2')`,
          hoursSold12mo: sql<string>`COALESCE(SUM(${retainers.hoursPurchased}) FILTER (WHERE ${retainers.purchaseDate} >= (CURRENT_DATE - INTERVAL '12 months')), 0)`,
          hoursConsumed12mo: sql<string>`COALESCE(SUM(${retainers.hoursConsumed}) FILTER (WHERE ${retainers.purchaseDate} >= (CURRENT_DATE - INTERVAL '12 months')), 0)`,
          expiring90d: sql<number>`COUNT(*) FILTER (WHERE ${retainers.status} IN ('active','exhausted') AND ${retainers.expiryDate} <= (CURRENT_DATE + INTERVAL '90 days'))`,
        })
        .from(retainers)
        .where(eq(retainers.firmId, session.firmId));
      const [offers] = await deps.db
        .select({
          openOffers: sql<number>`COUNT(*) FILTER (WHERE ${retainerOffers.status} = 'pending')`,
          purchased90d: sql<number>`COUNT(*) FILTER (WHERE ${retainerOffers.status} = 'purchased' AND ${retainerOffers.createdAt} >= (now() - INTERVAL '90 days'))`,
          declined90d: sql<number>`COUNT(*) FILTER (WHERE ${retainerOffers.status} = 'declined' AND ${retainerOffers.createdAt} >= (now() - INTERVAL '90 days'))`,
          expired90d: sql<number>`COUNT(*) FILTER (WHERE ${retainerOffers.status} = 'expired' AND ${retainerOffers.createdAt} >= (now() - INTERVAL '90 days'))`,
        })
        .from(retainerOffers)
        .where(eq(retainerOffers.firmId, session.firmId));
      res.json({
        kpis: {
          activeCount: Number(agg?.activeCount ?? 0),
          tier1Active: Number(agg?.tier1Active ?? 0),
          tier2Active: Number(agg?.tier2Active ?? 0),
          hoursSold12mo: Number(agg?.hoursSold12mo ?? 0),
          hoursConsumed12mo: Number(agg?.hoursConsumed12mo ?? 0),
          expiring90d: Number(agg?.expiring90d ?? 0),
          openOffers: Number(offers?.openOffers ?? 0),
          purchased90d: Number(offers?.purchased90d ?? 0),
          declined90d: Number(offers?.declined90d ?? 0),
          expired90d: Number(offers?.expired90d ?? 0),
        },
      });
    },
  );

  router.post(
    '/preview-split',
    requirePermission(deps, 'time_entry:create'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const Schema = z.object({
        engagementId: z.string().uuid(),
        entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        hours: z.number().positive().max(24),
        workCodeId: z.string().uuid().nullable().optional(),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.json({
          retainerId: null,
          applied: 0,
          spillover: parsed.data.hours,
          reason: 'no_retainer',
        });
        return;
      }
      const [eng] = await deps.db
        .select({ retainerId: engagements.retainerId })
        .from(engagements)
        .where(eq(engagements.id, parsed.data.engagementId))
        .limit(1);
      if (!eng?.retainerId) {
        res.json({
          retainerId: null,
          applied: 0,
          spillover: parsed.data.hours,
          reason: 'no_retainer',
        });
        return;
      }
      const [retainer] = await deps.db
        .select()
        .from(retainers)
        .where(and(eq(retainers.id, eng.retainerId), eq(retainers.firmId, session.firmId)))
        .limit(1);
      if (!retainer) {
        res.json({
          retainerId: null,
          applied: 0,
          spillover: parsed.data.hours,
          reason: 'no_retainer',
        });
        return;
      }
      const eligibilityResult = await deps.db.execute(
        sql`SELECT work_code_id FROM retainer_eligible_service WHERE retainer_id = ${retainer.id}`,
      );
      const eligibilityRows = Array.isArray(eligibilityResult)
        ? (eligibilityResult as unknown as { work_code_id: string }[])
        : ((eligibilityResult as unknown as { rows: { work_code_id: string }[] }).rows ?? []);
      const eligibleIds = eligibilityRows.map((r) => r.work_code_id);
      const elig = isEligibleEntry({
        retainer: {
          status: retainer.status,
          expiryDate:
            typeof retainer.expiryDate === 'string'
              ? retainer.expiryDate
              : new Date(retainer.expiryDate as unknown as Date).toISOString().slice(0, 10),
        },
        entryDate: parsed.data.entryDate,
        workCodeId: parsed.data.workCodeId ?? null,
        eligibleWorkCodeIds: eligibleIds,
      });
      if (!elig.ok) {
        res.json({
          retainerId: retainer.id,
          retainerStatus: retainer.status,
          applied: 0,
          spillover: parsed.data.hours,
          reason: elig.reason,
        });
        return;
      }
      const split = computeSplit({
        entryHours: parsed.data.hours,
        hoursPurchased: Number(retainer.hoursPurchased),
        hoursConsumed: Number(retainer.hoursConsumed),
      });
      res.json({
        retainerId: retainer.id,
        retainerStatus: retainer.status,
        applied: split.applied,
        spillover: split.spillover,
        willExhaust: split.willExhaust,
        reason: null,
      });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(retainers)
        .where(and(eq(retainers.id, req.params['id']!), eq(retainers.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const ledger = await deps.db
        .select()
        .from(retainerLedger)
        .where(eq(retainerLedger.retainerId, row.id))
        .orderBy(desc(retainerLedger.createdAt))
        .limit(500);
      res.json({ retainer: row, ledger });
    },
  );

  router.post(
    '/:id/void',
    requirePermission(deps, 'retainer:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const Schema = z.object({ reason: z.string().min(1).max(400) });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(retainers)
        .where(and(eq(retainers.id, req.params['id']!), eq(retainers.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (Number(row.hoursConsumed) > 0) {
        res.status(409).json({
          error: 'hours_already_consumed',
          hoursConsumed: row.hoursConsumed,
        });
        return;
      }
      if (row.status === 'void') {
        res.json({ ok: true, alreadyVoid: true });
        return;
      }
      await deps.db.transaction(async (tx) => {
        await tx
          .update(retainers)
          .set({
            status: 'void',
            voidedAt: new Date(),
            voidedById: session.appUserId,
            voidedReason: parsed.data.reason,
            updatedAt: new Date(),
          })
          .where(eq(retainers.id, row.id));
        await tx
          .update(engagements)
          .set({ retainerId: null })
          .where(eq(engagements.id, row.engagementId));
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'retainer',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { status: 'void', reason: parsed.data.reason },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
