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
import {
  clients,
  engagements,
  retainerEligibleServices,
  retainerLedger,
  retainerOffers,
  retainerTierConfigs,
  retainerTierEligibleServices,
  retainers,
} from '@vibe/db/schema';
import { computeExpiryDate, computeSplit, isEligibleEntry } from '@vibe/core/retainers';

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

  // ----- Staff-scoped (/my/retainers) --------------------------------
  // Visibility: retainers on engagements where the signed-in user is
  // either the engagement.partner_id / manager_id OR has a row in
  // engagement_assignment. Matches the "My Work" filter convention used
  // elsewhere (engagement-list, etc.). No write permissions; the page is
  // a pure read view.

  router.get(
    '/mine',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db.execute(
        sql`SELECT r.*
            FROM retainer r
            WHERE r.firm_id = ${session.firmId}
              AND r.engagement_id IN (
                SELECT e.id FROM engagement e
                WHERE e.partner_id = ${session.appUserId}
                   OR e.manager_id = ${session.appUserId}
                UNION
                SELECT ea.engagement_id FROM engagement_assignment ea
                WHERE ea.app_user_id = ${session.appUserId}
              )
            ORDER BY r.created_at DESC
            LIMIT 200`,
      );
      const rows = (items as unknown as { rows: Array<Record<string, unknown>> }).rows ?? [];
      res.json({
        items: rows.map((r) => ({
          id: r['id'],
          clientId: r['client_id'],
          engagementId: r['engagement_id'],
          tier: r['tier'],
          returnType: r['return_type'],
          taxYear: r['tax_year'],
          name: r['name'],
          hoursPurchased: String(r['hours_purchased']),
          hoursConsumed: String(r['hours_consumed']),
          expiryDate: String(r['expiry_date']).slice(0, 10),
          status: r['status'],
          priceCents: Number(r['price_cents']),
        })),
      });
    },
  );

  router.get(
    '/mine/kpis',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ kpis: null });
        return;
      }
      const agg = await deps.db.execute(
        sql`WITH my_eng AS (
              SELECT e.id FROM engagement e
              WHERE e.partner_id = ${session.appUserId}
                 OR e.manager_id = ${session.appUserId}
              UNION
              SELECT ea.engagement_id FROM engagement_assignment ea
              WHERE ea.app_user_id = ${session.appUserId}
            )
            SELECT
              COUNT(*) FILTER (WHERE r.status = 'active')                         ::int AS active_count,
              COALESCE(SUM(r.hours_purchased - r.hours_consumed)
                FILTER (WHERE r.status = 'active'), 0)::text                            AS hours_remaining,
              COUNT(*) FILTER (
                WHERE r.status = 'active'
                  AND (r.hours_purchased - r.hours_consumed) <= 1
              )::int                                                                    AS near_exhaustion,
              COUNT(*) FILTER (
                WHERE r.status IN ('active','exhausted')
                  AND r.expiry_date <= CURRENT_DATE + INTERVAL '90 days'
                  AND r.expiry_date >= CURRENT_DATE
              )::int                                                                    AS expiring_90d
            FROM retainer r
            WHERE r.firm_id = ${session.firmId}
              AND r.engagement_id IN (SELECT id FROM my_eng)`,
      );
      const row = (
        agg as unknown as {
          rows: Array<{
            active_count: number;
            hours_remaining: string;
            near_exhaustion: number;
            expiring_90d: number;
          }>;
        }
      ).rows[0];
      res.json({
        kpis: row
          ? {
              activeCount: Number(row.active_count ?? 0),
              hoursRemaining: Number(row.hours_remaining ?? 0),
              nearExhaustion: Number(row.near_exhaustion ?? 0),
              expiring90d: Number(row.expiring_90d ?? 0),
            }
          : null,
      });
    },
  );

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

  // ----- R7 — firm-initiated activation (no offer / no AR invoice) -----
  //
  // Manual path for a partner to create a retainer directly. Bypasses
  // the portal-purchase chain — used when the firm is collecting
  // payment out-of-band (cash, check, separate invoice) or comping
  // hours. Still enforces D2 (UNIQUE engagement_id) and uses the same
  // tier config + eligibility snapshot logic as the activation handler.

  router.post(
    '/manual',
    requirePermission(deps, 'retainer:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const Schema = z.object({
        engagementId: z.string().uuid(),
        tierConfigId: z.string().uuid(),
        // Optional overrides — when omitted, snapshot from the tier config.
        hoursPurchased: z.number().positive().max(10000).optional(),
        priceCents: z.number().int().nonnegative().optional(),
        name: z.string().min(1).max(120).optional(),
        // ISO YYYY-MM-DD. Defaults to today.
        purchaseDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        // ISO YYYY-MM-DD. When omitted, computed via D3 from engagement
        // due dates. Falls back to purchaseDate + 3y if engagement has
        // no due-date pair.
        expiryDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        // Optional eligibility override (list of work_code IDs). When
        // omitted, copies the tier_config's eligibility snapshot.
        eligibleWorkCodeIds: z.array(z.string().uuid()).optional(),
        notes: z.string().max(1000).optional(),
      });
      const parsed = Schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_input', detail: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }

      // Resolve engagement → client_id; scope-check the firm.
      const [eng] = await deps.db
        .select({
          id: engagements.id,
          clientId: engagements.clientId,
          retainerId: engagements.retainerId,
          originalDueDate: engagements.originalDueDate,
          extendedDueDate: engagements.extendedDueDate,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(engagements.id, parsed.data.engagementId), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      if (eng.retainerId) {
        res.status(409).json({ error: 'engagement_already_has_retainer' });
        return;
      }

      // Resolve tier config; scope-check to the firm.
      const [tierConfig] = await deps.db
        .select()
        .from(retainerTierConfigs)
        .where(
          and(
            eq(retainerTierConfigs.id, parsed.data.tierConfigId),
            eq(retainerTierConfigs.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!tierConfig) {
        res.status(404).json({ error: 'tier_config_not_found' });
        return;
      }

      const purchaseDate = parsed.data.purchaseDate ?? new Date().toISOString().slice(0, 10);
      // Expiry: explicit > engagement due-date pair > purchase + 3y.
      let expiryDate: string;
      if (parsed.data.expiryDate) {
        expiryDate = parsed.data.expiryDate;
      } else if (eng.originalDueDate || eng.extendedDueDate) {
        expiryDate = computeExpiryDate({
          originalDueDate: eng.originalDueDate,
          extendedDueDate: eng.extendedDueDate,
        });
      } else {
        // Compute purchase + 3 years inline (avoid bringing the
        // engagement due-date requirement into manual flow).
        const d = new Date(purchaseDate + 'T00:00:00Z');
        d.setUTCFullYear(d.getUTCFullYear() + 3);
        expiryDate = d.toISOString().slice(0, 10);
      }

      const hoursPurchased = parsed.data.hoursPurchased ?? Number(tierConfig.hours);
      const priceCents = parsed.data.priceCents ?? tierConfig.baseFeeCents;
      const name = parsed.data.name ?? tierConfig.name;

      const retainerId = await deps.db.transaction(async (tx) => {
        const [retainer] = await tx
          .insert(retainers)
          .values({
            firmId: session.firmId,
            clientId: eng.clientId,
            engagementId: eng.id,
            // R7 — no offer / no purchase invoice for manual activation.
            offerId: null,
            purchaseInvoiceId: null,
            tier: tierConfig.tier,
            returnType: tierConfig.returnType,
            taxYear: new Date(purchaseDate).getFullYear(),
            tierConfigId: tierConfig.id,
            name,
            hoursPurchased: String(hoursPurchased),
            hoursConsumed: '0',
            priceCents,
            purchaseDate,
            expiryDate,
            status: 'active',
            notes: parsed.data.notes ?? null,
          })
          .returning({ id: retainers.id });
        if (!retainer) throw new Error('retainer_insert_failed');

        // Snapshot eligibility: explicit override else tier config set.
        let eligibilityIds: string[];
        if (parsed.data.eligibleWorkCodeIds && parsed.data.eligibleWorkCodeIds.length > 0) {
          eligibilityIds = parsed.data.eligibleWorkCodeIds;
        } else {
          const rows = await tx
            .select({ workCodeId: retainerTierEligibleServices.workCodeId })
            .from(retainerTierEligibleServices)
            .where(eq(retainerTierEligibleServices.tierConfigId, tierConfig.id));
          eligibilityIds = rows.map((r) => r.workCodeId);
        }
        if (eligibilityIds.length > 0) {
          await tx
            .insert(retainerEligibleServices)
            .values(eligibilityIds.map((workCodeId) => ({ retainerId: retainer.id, workCodeId })));
        }

        await tx
          .update(engagements)
          .set({ retainerId: retainer.id })
          .where(eq(engagements.id, eng.id));

        await tx.insert(retainerLedger).values({
          retainerId: retainer.id,
          kind: 'ACTIVATION',
          hoursDelta: '0',
          hoursBalanceAfter: String(hoursPurchased),
          createdById: session.appUserId,
        });
        return retainer.id;
      });

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'retainer',
        entityId: retainerId,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'manual',
          engagementId: eng.id,
          tierConfigId: tierConfig.id,
          hoursPurchased,
          priceCents,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      // R4-followup — schedule expiry warnings for the manual retainer
      // too. Same best-effort pattern as the activation path.
      try {
        const { scheduleRetainerWarnings } = await import('./scheduler');
        void scheduleRetainerWarnings({ retainerId, expiryDate });
      } catch (err) {
        logger.error({ err, retainerId }, 'retainer warning scheduling failed (manual)');
      }

      res.status(201).json({ retainerId });
    },
  );

  // ----- R7 — pause / resume ------------------------------------------

  router.post(
    '/:id/pause',
    requirePermission(deps, 'retainer:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const Schema = z.object({ reason: z.string().max(400).optional() });
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
      if (row.status !== 'active') {
        res.status(409).json({ error: 'not_active', currentStatus: row.status });
        return;
      }
      await deps.db
        .update(retainers)
        .set({
          status: 'paused',
          pausedAt: new Date(),
          pausedReason: parsed.data.reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(retainers.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'retainer',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { status: 'paused', reason: parsed.data.reason ?? null },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      // R4-followup — kill in-flight expiry warnings while paused; the
      // firm will re-schedule on resume.
      try {
        const { cancelRetainerWarnings } = await import('./scheduler');
        void cancelRetainerWarnings(row.id);
      } catch (err) {
        logger.error({ err, retainerId: row.id }, 'cancel retainer warnings failed (pause)');
      }
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/resume',
    requirePermission(deps, 'retainer:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
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
      if (row.status !== 'paused') {
        res.status(409).json({ error: 'not_paused', currentStatus: row.status });
        return;
      }
      // If the retainer is now also past its expiry_date, the daily
      // sweep would have flipped to 'expired' — but during the paused
      // window the sweep skips us. Re-check explicitly so resuming a
      // long-paused retainer doesn't quietly re-activate beyond expiry.
      const today = new Date().toISOString().slice(0, 10);
      const nextStatus = row.expiryDate < today ? 'expired' : 'active';
      await deps.db
        .update(retainers)
        .set({
          status: nextStatus,
          pausedAt: null,
          pausedReason: null,
          updatedAt: new Date(),
        })
        .where(eq(retainers.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'retainer',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { status: nextStatus, resumed: true },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      // R4-followup — re-schedule warnings when resuming back to
      // active. Skip when we flipped straight to expired.
      if (nextStatus === 'active') {
        try {
          const { scheduleRetainerWarnings } = await import('./scheduler');
          void scheduleRetainerWarnings({
            retainerId: row.id,
            expiryDate: String(row.expiryDate).slice(0, 10),
          });
        } catch (err) {
          logger.error({ err, retainerId: row.id }, 'reschedule retainer warnings failed (resume)');
        }
      }
      res.json({ ok: true, status: nextStatus });
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
      // R4-followup — kill any in-flight expiry warnings for the
      // voided retainer.
      try {
        const { cancelRetainerWarnings } = await import('./scheduler');
        void cancelRetainerWarnings(row.id);
      } catch (err) {
        logger.error({ err, retainerId: row.id }, 'cancel retainer warnings failed (void)');
      }
      res.json({ ok: true });
    },
  );

  // ----- R6-followup — CSV exports -----------------------------------

  router.get(
    '/exports/ledger.csv',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const retainerIdRaw = uuidQueryParam(req.query['retainerId']);
      if (retainerIdRaw === 'invalid' || !retainerIdRaw) {
        res.status(400).json({ error: 'retainerId_required' });
        return;
      }
      const retainerId = retainerIdRaw;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [retainer] = await deps.db
        .select({ id: retainers.id })
        .from(retainers)
        .where(and(eq(retainers.id, retainerId), eq(retainers.firmId, session.firmId)))
        .limit(1);
      if (!retainer) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await deps.db
        .select({
          createdAt: retainerLedger.createdAt,
          kind: retainerLedger.kind,
          hoursDelta: retainerLedger.hoursDelta,
          hoursBalanceAfter: retainerLedger.hoursBalanceAfter,
          timeEntryId: retainerLedger.timeEntryId,
          createdById: retainerLedger.createdById,
        })
        .from(retainerLedger)
        .where(eq(retainerLedger.retainerId, retainer.id))
        .orderBy(retainerLedger.createdAt);
      const { buildLedgerCsv } = await import('./exports');
      const csv = buildLedgerCsv(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="retainer-ledger-${retainer.id}.csv"`,
      );
      res.send(csv);
    },
  );

  router.get(
    '/exports/funnel.csv',
    requirePermission(deps, 'retainer:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const fromQuery = String(req.query['from'] ?? '');
      const toQuery = String(req.query['to'] ?? '');
      const today = new Date().toISOString().slice(0, 10);
      const defaultFrom = new Date(Date.now() - 90 * 24 * 3600_000).toISOString().slice(0, 10);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(fromQuery) ? fromQuery : defaultFrom;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(toQuery) ? toQuery : today;
      const rows = await deps.db.execute(
        sql`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket,
                   COUNT(*) FILTER (WHERE status = 'pending')          ::int AS pending,
                   COUNT(*) FILTER (WHERE status = 'pending_payment')  ::int AS pending_payment,
                   COUNT(*) FILTER (WHERE status = 'purchased')        ::int AS purchased,
                   COUNT(*) FILTER (WHERE status = 'declined')         ::int AS declined,
                   COUNT(*) FILTER (WHERE status = 'expired')          ::int AS expired
            FROM retainer_offer
            WHERE firm_id = ${session.firmId}
              AND created_at >= ${from}::date
              AND created_at <  (${to}::date + INTERVAL '1 day')
            GROUP BY bucket
            ORDER BY bucket`,
      );
      const ravel =
        (
          rows as unknown as {
            rows: Array<{
              bucket: string;
              pending: number;
              pending_payment: number;
              purchased: number;
              declined: number;
              expired: number;
            }>;
          }
        ).rows ?? [];
      const { buildOfferFunnelCsv } = await import('./exports');
      const csv = buildOfferFunnelCsv(
        ravel.map((r) => ({
          bucket: r.bucket,
          pendingCount: r.pending,
          pendingPaymentCount: r.pending_payment,
          purchasedCount: r.purchased,
          declinedCount: r.declined,
          expiredCount: r.expired,
        })),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="retainer-offer-funnel-${from}-to-${to}.csv"`,
      );
      res.send(csv);
    },
  );

  return router;
}
