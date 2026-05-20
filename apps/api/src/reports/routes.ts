// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Reporting endpoints — Phase 17. Realization rollups straight off
// `adjustment_allocation`. No materialized view yet — the query joins to
// engagement→client to scope by firm and groups in SQL, then rolls per
// dimension via @vibe/core/reporting.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';

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
