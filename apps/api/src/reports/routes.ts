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
} from '@vibe/db/schema';
import { rollup, rollupBy, type AllocationRow } from '@vibe/core/reporting';

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

  return router;
}
