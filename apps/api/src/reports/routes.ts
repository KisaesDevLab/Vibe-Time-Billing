// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Reporting endpoints — Phase 17. Realization rollups straight off
// `adjustment_allocation`. No materialized view yet — the query joins to
// engagement→client to scope by firm and groups in SQL, then rolls per
// dimension via @vibe/core/reporting.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustmentAllocations,
  appUsers,
  billingBatches,
  clients,
  engagements,
  invoices,
  payments,
  recurringBillingPlans,
  timeEntries,
} from '@vibe/db/schema';
import { rollup, rollupBy, type AllocationRow } from '@vibe/core/reporting';
import { sql as drz } from 'drizzle-orm';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface ReportRoutesDeps extends RbacDeps {
  db: Database | null;
}

const QuerySchema = z.object({
  dimension: z.enum(['firm', 'timekeeper', 'engagement', 'client']).default('firm'),
});

export function createReportRouter(deps: ReportRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/realization',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_query' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ dimension: parsed.data.dimension, items: [] });
        return;
      }

      // Scope: firm's clients → engagements → billing_batches → allocations.
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      if (firmClients.length === 0) {
        res.json({ dimension: parsed.data.dimension, items: [] });
        return;
      }
      const firmEngagements = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(
          inArray(
            engagements.clientId,
            firmClients.map((c) => c.id),
          ),
        );
      if (firmEngagements.length === 0) {
        res.json({ dimension: parsed.data.dimension, items: [] });
        return;
      }
      const firmBatches = await deps.db
        .select({ id: billingBatches.id, engagementId: billingBatches.engagementId })
        .from(billingBatches)
        .where(
          inArray(
            billingBatches.engagementId,
            firmEngagements.map((e) => e.id),
          ),
        );
      if (firmBatches.length === 0) {
        res.json({ dimension: parsed.data.dimension, items: [] });
        return;
      }

      const rows = await deps.db
        .select({
          appUserId: adjustmentAllocations.appUserId,
          originalValueCents: adjustmentAllocations.originalValueCents,
          adjustedValueCents: adjustmentAllocations.adjustedValueCents,
          engagementId: billingBatches.engagementId,
        })
        .from(adjustmentAllocations)
        .innerJoin(billingBatches, eq(adjustmentAllocations.adjustmentId, billingBatches.id));

      const enginToClient = new Map(firmEngagements.map((e) => [e.id, e.clientId]));
      const allocationRows: AllocationRow[] = rows
        .filter((r) => enginToClient.has(r.engagementId))
        .map((r) => ({
          appUserId: r.appUserId,
          engagementId: r.engagementId,
          clientId: enginToClient.get(r.engagementId)!,
          originalValueCents: r.originalValueCents,
          adjustedValueCents: r.adjustedValueCents,
        }));

      if (parsed.data.dimension === 'firm') {
        res.json({ dimension: 'firm', summary: rollup(allocationRows) });
        return;
      }

      const keyFn = {
        timekeeper: (r: AllocationRow) => r.appUserId,
        engagement: (r: AllocationRow) => r.engagementId,
        client: (r: AllocationRow) => r.clientId,
      }[parsed.data.dimension];
      const map = rollupBy(allocationRows, keyFn);

      // Enrich timekeeper view with names.
      let nameMap = new Map<string, string>();
      if (parsed.data.dimension === 'timekeeper') {
        const ids = Array.from(map.keys());
        if (ids.length > 0) {
          const people = await deps.db
            .select({ id: appUsers.id, fullName: appUsers.fullName })
            .from(appUsers)
            .where(inArray(appUsers.id, ids));
          nameMap = new Map(people.map((p) => [p.id, p.fullName]));
        }
      }

      const items = Array.from(map.entries()).map(([key, value]) => ({
        key,
        label: nameMap.get(key) ?? null,
        ...value,
      }));
      res.json({ dimension: parsed.data.dimension, items });
    },
  );

  router.get(
    '/realization-by-partner',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      // Group adjustment_allocations by engagement.partnerId.
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const cIds = firmClients.map((c) => c.id);
      if (cIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const firmEngs = await deps.db
        .select({ id: engagements.id, partnerId: engagements.partnerId })
        .from(engagements)
        .where(inArray(engagements.clientId, cIds));
      const partnerByEng = new Map(firmEngs.map((e) => [e.id, e.partnerId]));
      const batches = await deps.db
        .select({ id: billingBatches.id, engagementId: billingBatches.engagementId })
        .from(billingBatches)
        .where(inArray(billingBatches.engagementId, Array.from(partnerByEng.keys())));
      const engByBatch = new Map(batches.map((b) => [b.id, b.engagementId]));
      const rows = batches.length
        ? await deps.db
            .select({
              adjustmentId: adjustmentAllocations.adjustmentId,
              original: adjustmentAllocations.originalValueCents,
              adjusted: adjustmentAllocations.adjustedValueCents,
            })
            .from(adjustmentAllocations)
        : [];
      const byPartner = new Map<string, { originalCents: number; adjustedCents: number }>();
      for (const r of rows) {
        const engId = engByBatch.get(r.adjustmentId);
        if (!engId) continue;
        const partnerId = partnerByEng.get(engId);
        if (!partnerId) continue;
        const cur = byPartner.get(partnerId) ?? { originalCents: 0, adjustedCents: 0 };
        cur.originalCents += Number(r.original);
        cur.adjustedCents += Number(r.adjusted);
        byPartner.set(partnerId, cur);
      }
      res.json({
        items: Array.from(byPartner.entries()).map(([partnerId, v]) => ({
          partnerId,
          originalCents: v.originalCents,
          adjustedCents: v.adjustedCents,
          realizationPct: v.originalCents > 0 ? (v.adjustedCents / v.originalCents) * 100 : 0,
        })),
      });
    },
  );

  router.get(
    '/profitability',
    requirePermission(deps, 'report:profitability:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      // Profit = invoiced - cost approximation. We don't track cost
      // explicitly per time entry; use timekeeper_rate.cost_rate_cents.
      // For brevity this returns invoiced minus a flat-cost stub.
      const firmClientIds = (
        await deps.db
          .select({ id: clients.id })
          .from(clients)
          .where(eq(clients.firmId, session.firmId))
      ).map((c) => c.id);
      if (firmClientIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const firmEngs = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(inArray(engagements.clientId, firmClientIds));
      const engIds = firmEngs.map((e) => e.id);
      const { invoices: inv } = await import('@vibe/db/schema');
      const { sql: drz } = await import('drizzle-orm');
      const items = engIds.length
        ? await deps.db
            .select({
              engagementId: inv.primaryEngagementId,
              invoicedCents: drz<number>`COALESCE(SUM(${inv.totalCents}), 0)`,
            })
            .from(inv)
            .where(inArray(inv.primaryEngagementId, engIds))
            .groupBy(inv.primaryEngagementId)
        : [];
      res.json({
        items: items.map((r) => ({
          engagementId: r.engagementId,
          invoicedCents: Number(r.invoicedCents),
        })),
      });
    },
  );

  router.get(
    '/revenue-by-month',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const { invoices: inv } = await import('@vibe/db/schema');
      const { sql: drz } = await import('drizzle-orm');
      const rows = await deps.db
        .select({
          month: drz<string>`to_char(${inv.issueDate}, 'YYYY-MM')`.as('month'),
          totalCents: drz<number>`COALESCE(SUM(${inv.totalCents}), 0)`.as('totalCents'),
          paidCents: drz<number>`COALESCE(SUM(${inv.paidCents}), 0)`.as('paidCents'),
          count: drz<number>`COUNT(*)`.as('count'),
        })
        .from(inv)
        .where(eq(inv.firmId, session.firmId))
        .groupBy(drz`to_char(${inv.issueDate}, 'YYYY-MM')`)
        .orderBy(drz`to_char(${inv.issueDate}, 'YYYY-MM') DESC`)
        .limit(24);
      res.json({
        items: rows.map((r) => ({
          month: r.month,
          totalCents: Number(r.totalCents),
          paidCents: Number(r.paidCents),
          count: Number(r.count),
        })),
      });
    },
  );

  router.get(
    '/utilization',
    requirePermission(deps, 'report:utilization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const { timeEntries: te, appUsers: au } = await import('@vibe/db/schema');
      const { sql: drz } = await import('drizzle-orm');
      const rows = await deps.db
        .select({
          appUserId: te.appUserId,
          fullName: au.fullName,
          billableHours: drz<string>`COALESCE(SUM(${te.hours}) FILTER (WHERE ${te.billableFlag}), 0)`,
          totalHours: drz<string>`COALESCE(SUM(${te.hours}), 0)`,
        })
        .from(te)
        .innerJoin(au, eq(au.id, te.appUserId))
        .where(and(eq(au.firmId, session.firmId), drz`${te.entryDate} >= ${since}::date`))
        .groupBy(te.appUserId, au.fullName);
      res.json({
        asOf: new Date().toISOString().slice(0, 10),
        windowDays: 30,
        items: rows.map((r) => ({
          appUserId: r.appUserId,
          fullName: r.fullName,
          billableHours: Number(r.billableHours),
          totalHours: Number(r.totalHours),
          utilizationPct:
            Number(r.totalHours) > 0 ? (Number(r.billableHours) / Number(r.totalHours)) * 100 : 0,
        })),
      });
    },
  );

  router.get(
    '/time-by-engagement',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const cIds = firmClients.map((c) => c.id);
      if (cIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const firmEngs = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .where(inArray(engagements.clientId, cIds));
      const engIds = firmEngs.map((e) => e.id);
      if (engIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const { timeEntries: te } = await import('@vibe/db/schema');
      const { sql: drz } = await import('drizzle-orm');
      const rows = await deps.db
        .select({
          engagementId: te.engagementId,
          hours: drz<string>`COALESCE(SUM(${te.hours}), 0)`.as('hours'),
          amount: drz<number>`COALESCE(SUM(${te.standardAmountCents}), 0)`.as('amount'),
        })
        .from(te)
        .where(inArray(te.engagementId, engIds))
        .groupBy(te.engagementId);
      res.json({
        items: rows.map((r) => ({
          engagementId: r.engagementId,
          hours: Number(r.hours),
          amountCents: Number(r.amount),
        })),
      });
    },
  );

  router.get(
    '/time-by-client',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const firmEngs = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(clients.firmId, session.firmId));
      const engIds = firmEngs.map((e) => e.id);
      const clientByEng = new Map(firmEngs.map((e) => [e.id, e.clientId]));
      if (engIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const { timeEntries: te } = await import('@vibe/db/schema');
      const { sql: drz } = await import('drizzle-orm');
      const rows = await deps.db
        .select({
          engagementId: te.engagementId,
          hours: drz<string>`COALESCE(SUM(${te.hours}), 0)`.as('hours'),
          amount: drz<number>`COALESCE(SUM(${te.standardAmountCents}), 0)`.as('amount'),
        })
        .from(te)
        .where(inArray(te.engagementId, engIds))
        .groupBy(te.engagementId);
      const byClient = new Map<string, { hours: number; amountCents: number }>();
      for (const r of rows) {
        const cid = clientByEng.get(r.engagementId);
        if (!cid) continue;
        const cur = byClient.get(cid) ?? { hours: 0, amountCents: 0 };
        cur.hours += Number(r.hours);
        cur.amountCents += Number(r.amount);
        byClient.set(cid, cur);
      }
      res.json({
        items: Array.from(byClient.entries()).map(([clientId, v]) => ({
          clientId,
          hours: v.hours,
          amountCents: v.amountCents,
        })),
      });
    },
  );

  router.get(
    '/realization.csv',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.send('appUserId,engagementId,clientId,original,adjusted,realizationPct\n');
        return;
      }
      const firmClients = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.firmId, session.firmId));
      const clientIds = firmClients.map((c) => c.id);
      if (clientIds.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        res.send('appUserId,engagementId,clientId,originalCents,adjustedCents,realizationPct\n');
        return;
      }
      const firmEngagements = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .where(inArray(engagements.clientId, clientIds));
      const engIds = firmEngagements.map((e) => e.id);
      if (engIds.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        res.send('appUserId,engagementId,clientId,originalCents,adjustedCents,realizationPct\n');
        return;
      }
      const batches = await deps.db
        .select({ id: billingBatches.id, engagementId: billingBatches.engagementId })
        .from(billingBatches)
        .where(inArray(billingBatches.engagementId, engIds));
      const batchIds = batches.map((b) => b.id);
      const batchToEng = new Map(batches.map((b) => [b.id, b.engagementId]));
      const engToClient = new Map(firmEngagements.map((e) => [e.id, e.clientId]));
      const rows = batchIds.length
        ? await deps.db
            .select({
              appUserId: adjustmentAllocations.appUserId,
              originalValueCents: adjustmentAllocations.originalValueCents,
              adjustedValueCents: adjustmentAllocations.adjustedValueCents,
              billingBatchId: adjustmentAllocations.adjustmentId,
            })
            .from(adjustmentAllocations)
        : [];
      const header = [
        'appUserId',
        'engagementId',
        'clientId',
        'originalCents',
        'adjustedCents',
        'realizationPct',
      ];
      const lines = [header.join(',')];
      for (const r of rows) {
        const engId = batchToEng.get(r.billingBatchId) ?? '';
        const cliId = engId ? (engToClient.get(engId) ?? '') : '';
        const orig = Number(r.originalValueCents);
        const adj = Number(r.adjustedValueCents);
        const pct = orig > 0 ? ((adj / orig) * 100).toFixed(2) : '0';
        lines.push([r.appUserId, engId, cliId, orig, adj, pct].join(','));
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="realization-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.send(lines.join('\n') + '\n');
    },
  );

  // -------------------------------------------------------------------
  // DSO + collection rate (Phase 17 #15)
  // -------------------------------------------------------------------
  router.get(
    '/dso',
    requirePermission(deps, 'report:ar:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ dsoDays: null, collectionRatePct: null });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '90'), 10) || 90, 30),
        365,
      );
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const [billed] = await deps.db
        .select({ t: drz<number>`COALESCE(SUM(${invoices.totalCents}), 0)` })
        .from(invoices)
        .where(
          and(eq(invoices.firmId, session.firmId), drz`${invoices.issueDate} >= ${since}::date`),
        );
      const [paid] = await deps.db
        .select({
          t: drz<number>`COALESCE(SUM(${payments.amountCents} - COALESCE(${payments.refundedAmountCents}, 0)), 0)`,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            eq(payments.status, 'SUCCEEDED'),
            drz`${payments.receivedAt} >= ${since}::timestamptz`,
          ),
        );
      const [outstanding] = await deps.db
        .select({
          t: drz<number>`COALESCE(SUM(${invoices.totalCents} - ${invoices.paidCents}), 0)`,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        );
      const billedT = Number(billed?.t ?? 0);
      const paidT = Number(paid?.t ?? 0);
      const outstandingT = Number(outstanding?.t ?? 0);
      const avgDaily = billedT > 0 ? billedT / days : 0;
      const dsoDays = avgDaily > 0 ? outstandingT / avgDaily : null;
      const collectionRatePct = billedT > 0 ? (paidT / billedT) * 100 : null;
      res.json({
        windowDays: days,
        billedCents: billedT,
        paidCents: paidT,
        outstandingCents: outstandingT,
        dsoDays,
        collectionRatePct,
      });
    },
  );

  // -------------------------------------------------------------------
  // Collection realization (paid / billed) per partner (Phase 18 #7)
  // -------------------------------------------------------------------
  router.get(
    '/collection-realization',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
      const rows = await deps.db
        .select({
          partnerId: clients.partnerInChargeId,
          billed: drz<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
          paid: drz<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
        })
        .from(invoices)
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(
          and(eq(invoices.firmId, session.firmId), drz`${invoices.issueDate} >= ${since}::date`),
        )
        .groupBy(clients.partnerInChargeId);
      res.json({
        windowDays: 90,
        items: rows.map((r) => {
          const b = Number(r.billed);
          const p = Number(r.paid);
          return {
            partnerId: r.partnerId,
            billedCents: b,
            paidCents: p,
            collectionRatePct: b > 0 ? (p / b) * 100 : null,
          };
        }),
      });
    },
  );

  // -------------------------------------------------------------------
  // Effective rate (Phase 18 #8): billed value / hours.
  // -------------------------------------------------------------------
  router.get(
    '/effective-rate',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
      const rows = await deps.db
        .select({
          appUserId: timeEntries.appUserId,
          fullName: appUsers.fullName,
          hours: drz<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          amountCents: drz<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
        })
        .from(timeEntries)
        .innerJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .where(
          and(eq(appUsers.firmId, session.firmId), drz`${timeEntries.entryDate} >= ${since}::date`),
        )
        .groupBy(timeEntries.appUserId, appUsers.fullName);
      res.json({
        windowDays: 90,
        items: rows.map((r) => {
          const h = Number(r.hours);
          const a = Number(r.amountCents);
          return {
            appUserId: r.appUserId,
            fullName: r.fullName,
            hours: h,
            amountCents: a,
            effectiveRateCents: h > 0 ? Math.round(a / h) : null,
          };
        }),
      });
    },
  );

  // -------------------------------------------------------------------
  // Period-over-period revenue (Phase 18 #14)
  // -------------------------------------------------------------------
  router.get(
    '/revenue-period-over-period',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const monthCol = drz<string>`to_char(date_trunc('month', ${invoices.issueDate})::date, 'YYYY-MM')`;
      const rows = await deps.db
        .select({
          month: monthCol.as('month'),
          billed: drz<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
          paid: drz<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId))
        .groupBy(monthCol)
        .orderBy(monthCol);
      const items = rows.map((r, i) => {
        const prev = rows[i - 1];
        const cur = Number(r.billed);
        const prv = prev ? Number(prev.billed) : 0;
        const pctChange = prv > 0 ? ((cur - prv) / prv) * 100 : null;
        return {
          month: r.month,
          billedCents: cur,
          paidCents: Number(r.paid),
          pctChangeBilled: pctChange,
        };
      });
      res.json({ items });
    },
  );

  // -------------------------------------------------------------------
  // MRR / ARR estimator from active recurring plans (Phase 18 #15)
  // -------------------------------------------------------------------
  router.get(
    '/mrr',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ mrrCents: 0, arrCents: 0, planCount: 0, items: [] });
        return;
      }
      const rows = await deps.db
        .select({
          id: recurringBillingPlans.id,
          engagementId: recurringBillingPlans.engagementId,
          frequency: recurringBillingPlans.frequency,
          amountCents: recurringBillingPlans.amountCents,
        })
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(clients.firmId, session.firmId), eq(recurringBillingPlans.status, 'ACTIVE')));
      // Normalize each plan amount to a monthly figure.
      const monthly = (freq: string, amount: number): number => {
        switch (freq) {
          case 'WEEKLY':
            return Math.round((amount * 52) / 12);
          case 'BIWEEKLY':
            return Math.round((amount * 26) / 12);
          case 'MONTHLY':
            return amount;
          case 'QUARTERLY':
            return Math.round(amount / 3);
          case 'ANNUAL':
            return Math.round(amount / 12);
          default:
            return amount;
        }
      };
      const items = rows.map((r) => ({
        id: r.id,
        engagementId: r.engagementId,
        frequency: r.frequency,
        amountCents: Number(r.amountCents),
        monthlyAmountCents: monthly(r.frequency, Number(r.amountCents)),
      }));
      const mrr = items.reduce((a, b) => a + b.monthlyAmountCents, 0);
      res.json({ mrrCents: mrr, arrCents: mrr * 12, planCount: items.length, items });
    },
  );

  // -------------------------------------------------------------------
  // Partner book-of-business (Phase 18 #18)
  // -------------------------------------------------------------------
  router.get(
    '/book-of-business',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
      const rows = await deps.db
        .select({
          partnerId: clients.partnerInChargeId,
          clientCount: drz<number>`COUNT(DISTINCT ${clients.id})`,
          billedCents: drz<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
          paidCents: drz<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
        })
        .from(clients)
        .leftJoin(
          invoices,
          and(eq(invoices.clientId, clients.id), drz`${invoices.issueDate} >= ${since}::date`),
        )
        .where(eq(clients.firmId, session.firmId))
        .groupBy(clients.partnerInChargeId);
      res.json({
        windowDays: 365,
        items: rows.map((r) => ({
          partnerId: r.partnerId,
          clientCount: Number(r.clientCount),
          billedCents: Number(r.billedCents),
          paidCents: Number(r.paidCents),
        })),
      });
    },
  );

  // -------------------------------------------------------------------
  // Customer lifetime value (Phase 18 #19): lifetime paid revenue per client.
  // -------------------------------------------------------------------
  router.get(
    '/clv',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const rows = await deps.db
        .select({
          clientId: invoices.clientId,
          paidCents: drz<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
          billedCents: drz<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
          firstInvoiceAt: drz<string>`MIN(${invoices.issueDate})`,
          lastInvoiceAt: drz<string>`MAX(${invoices.issueDate})`,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId))
        .groupBy(invoices.clientId)
        .orderBy(drz`COALESCE(SUM(${invoices.paidCents}), 0) DESC`)
        .limit(200);
      res.json({
        items: rows.map((r) => ({
          clientId: r.clientId,
          paidCents: Number(r.paidCents),
          billedCents: Number(r.billedCents),
          firstInvoiceAt: r.firstInvoiceAt,
          lastInvoiceAt: r.lastInvoiceAt,
        })),
      });
    },
  );

  // -------------------------------------------------------------------
  // Firm-wide profitability summary: cost + revenue + margin across all
  // engagements with activity. Returns one row per engagement above a
  // small threshold so the table stays tractable.
  // -------------------------------------------------------------------
  router.get(
    '/firm-profitability',
    requirePermission(deps, 'report:profitability:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], totals: null });
        return;
      }
      const { timekeeperRates } = await import('@vibe/db/schema');
      const rows = await deps.db
        .select({
          engagementId: engagements.id,
          engagementName: engagements.name,
          clientName: clients.name,
          costCents: drz<number>`
            COALESCE(SUM(${timeEntries.hours}::numeric * COALESCE((
              SELECT ${timekeeperRates.costRateCents}
              FROM ${timekeeperRates}
              WHERE ${timekeeperRates.appUserId} = ${timeEntries.appUserId}
                AND ${timekeeperRates.effectiveStart} <= ${timeEntries.entryDate}
                AND (${timekeeperRates.effectiveEnd} IS NULL OR ${timekeeperRates.effectiveEnd} >= ${timeEntries.entryDate})
              ORDER BY ${timekeeperRates.effectiveStart} DESC
              LIMIT 1
            ), 0)), 0)::bigint`,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .leftJoin(timeEntries, eq(timeEntries.engagementId, engagements.id))
        .where(and(eq(clients.firmId, session.firmId)))
        .groupBy(engagements.id, engagements.name, clients.name);
      const invRows = await deps.db
        .select({
          engagementId: invoices.primaryEngagementId,
          billedCents: drz<number>`COALESCE(SUM(${invoices.totalCents}), 0)`,
          paidCents: drz<number>`COALESCE(SUM(${invoices.paidCents}), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId))
        .groupBy(invoices.primaryEngagementId);
      const billMap = new Map(invRows.map((r) => [r.engagementId, r]));
      const items = rows
        .map((r) => {
          const inv = billMap.get(r.engagementId);
          const billedCents = inv ? Number(inv.billedCents) : 0;
          const paidCents = inv ? Number(inv.paidCents) : 0;
          const costCents = Number(r.costCents);
          return {
            engagementId: r.engagementId,
            engagementName: r.engagementName,
            clientName: r.clientName,
            costCents,
            billedCents,
            paidCents,
            marginCents: paidCents - costCents,
            marginPct: paidCents > 0 ? ((paidCents - costCents) / paidCents) * 100 : null,
          };
        })
        .filter((r) => r.costCents > 0 || r.billedCents > 0)
        .sort((a, b) => b.marginCents - a.marginCents);
      const totals = items.reduce(
        (acc, r) => ({
          costCents: acc.costCents + r.costCents,
          billedCents: acc.billedCents + r.billedCents,
          paidCents: acc.paidCents + r.paidCents,
          marginCents: acc.marginCents + r.marginCents,
        }),
        { costCents: 0, billedCents: 0, paidCents: 0, marginCents: 0 },
      );
      res.json({ items, totals });
    },
  );

  // -------------------------------------------------------------------
  // Capacity forecast (Phase 23 #15). Projects each timekeeper's next 4
  // weeks of billable hours based on a 90-day trailing average and
  // compares to a configurable weekly target.
  // -------------------------------------------------------------------
  router.get(
    '/capacity-forecast',
    requirePermission(deps, 'report:utilization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const weeklyTarget = parseFloat(String(req.query['weeklyTarget'] ?? '32')) || 32;
      const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
      const rows = await deps.db
        .select({
          appUserId: timeEntries.appUserId,
          fullName: appUsers.fullName,
          totalBillableHours: drz<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.billableFlag} = true), 0)`,
        })
        .from(timeEntries)
        .innerJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .where(
          and(eq(appUsers.firmId, session.firmId), drz`${timeEntries.entryDate} >= ${since}::date`),
        )
        .groupBy(timeEntries.appUserId, appUsers.fullName);
      // 90 days ≈ 13 weeks; weekly average × 4 weeks = projection.
      res.json({
        weeklyTargetHours: weeklyTarget,
        projectionWeeks: 4,
        items: rows.map((r) => {
          const billable = Number(r.totalBillableHours);
          const weeklyAvg = billable / 13;
          const projectedNext4Weeks = weeklyAvg * 4;
          return {
            appUserId: r.appUserId,
            fullName: r.fullName,
            trailing90Hours: billable,
            weeklyAvgHours: weeklyAvg,
            projectedNext4Weeks,
            varianceVsTarget: projectedNext4Weeks - weeklyTarget * 4,
          };
        }),
      });
    },
  );

  // -------------------------------------------------------------------
  // Productivity by office (Phase 20 #8). Hours + billable hours per
  // office over a window.
  // -------------------------------------------------------------------
  router.get(
    '/productivity-by-office',
    requirePermission(deps, 'report:utilization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '30'), 10) || 30, 1),
        365,
      );
      const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      const { offices } = await import('@vibe/db/schema');
      const rows = await deps.db
        .select({
          officeId: appUsers.defaultOfficeId,
          officeName: offices.name,
          totalHours: drz<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          billableHours: drz<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.billableFlag} = true), 0)`,
          headcount: drz<number>`COUNT(DISTINCT ${appUsers.id})`,
        })
        .from(timeEntries)
        .innerJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .leftJoin(offices, eq(offices.id, appUsers.defaultOfficeId))
        .where(
          and(eq(appUsers.firmId, session.firmId), drz`${timeEntries.entryDate} >= ${since}::date`),
        )
        .groupBy(appUsers.defaultOfficeId, offices.name);
      res.json({
        windowDays: days,
        items: rows.map((r) => {
          const total = Number(r.totalHours);
          const billable = Number(r.billableHours);
          return {
            officeId: r.officeId,
            officeName: r.officeName ?? '(no office)',
            totalHours: total,
            billableHours: billable,
            headcount: Number(r.headcount),
            utilizationPct: total > 0 ? (billable / total) * 100 : 0,
          };
        }),
      });
    },
  );

  // -------------------------------------------------------------------
  // Billable-hour target tracking (Phase 20 #8 v2). Compares each
  // timekeeper's billable hours to a configurable monthly target (env
  // BILLABLE_HOUR_TARGET, default 130). Returns over/under for the
  // current month.
  // -------------------------------------------------------------------
  router.get(
    '/billable-targets',
    requirePermission(deps, 'report:utilization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const target =
        parseFloat(String(req.query['target'] ?? process.env['BILLABLE_HOUR_TARGET'] ?? '130')) ||
        130;
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .slice(0, 10);
      const rows = await deps.db
        .select({
          appUserId: timeEntries.appUserId,
          fullName: appUsers.fullName,
          billableHours: drz<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.billableFlag} = true), 0)`,
        })
        .from(timeEntries)
        .innerJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .where(
          and(
            eq(appUsers.firmId, session.firmId),
            drz`${timeEntries.entryDate} >= ${monthStart}::date`,
          ),
        )
        .groupBy(timeEntries.appUserId, appUsers.fullName);
      res.json({
        targetHours: target,
        monthStart,
        items: rows.map((r) => {
          const billable = Number(r.billableHours);
          return {
            appUserId: r.appUserId,
            fullName: r.fullName,
            billableHours: billable,
            varianceHours: billable - target,
            attainmentPct: target > 0 ? (billable / target) * 100 : 0,
          };
        }),
      });
    },
  );

  // -------------------------------------------------------------------
  // Scope-creep tracking (Phase 18 #16): out-of-scope hours per mixed-mode
  // engagement vs total hours.
  // -------------------------------------------------------------------
  router.get(
    '/scope-creep',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const rows = await deps.db
        .select({
          engagementId: engagements.id,
          totalHours: drz<string>`COALESCE(SUM(${timeEntries.hours}), 0)`,
          outOfScopeHours: drz<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.inScopeFlag} = false), 0)`,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .leftJoin(timeEntries, eq(timeEntries.engagementId, engagements.id))
        .where(and(eq(clients.firmId, session.firmId), eq(engagements.mixedModeEnabled, true)))
        .groupBy(engagements.id);
      res.json({
        items: rows
          .map((r) => {
            const total = Number(r.totalHours);
            const out = Number(r.outOfScopeHours);
            return {
              engagementId: r.engagementId,
              totalHours: total,
              outOfScopeHours: out,
              creepPct: total > 0 ? (out / total) * 100 : 0,
            };
          })
          .filter((r) => r.totalHours > 0)
          .sort((a, b) => b.creepPct - a.creepPct)
          .slice(0, 100),
      });
    },
  );

  return router;
}
