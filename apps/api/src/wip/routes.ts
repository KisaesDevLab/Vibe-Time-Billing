// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P23 — Engagement WIP rollup staff API.
//
// One endpoint, two response shapes:
//   GET /api/staff/wip/:engagementId          → JSON rollup
//   GET /api/staff/wip/:engagementId?format=csv → CSV download
//
// All math lives in @vibe/core/proposals (wip-rollup). This file is
// thin glue: load engagement + time entries + billed amount, hand to
// the helper, project to JSON or CSV.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clients,
  engagements,
  invoiceLineItems,
  invoices,
  timeEntries,
  workCodes,
} from '@vibe/db/schema';
import {
  rollUpEngagementWip,
  wipRollupToCsv,
  type TimeEntryForWip,
  type WipFeeStructure,
} from '@vibe/core/proposals';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface WipRoutesDeps extends RbacDeps {
  db: Database | null;
}

async function loadBilledCents(
  db: Database,
  engagementId: string,
  firmId: string,
): Promise<number> {
  // Sum invoice_line_item.amount_cents where engagement_id matches and
  // the parent invoice is in a billable state (DRAFT excluded). Joining
  // through invoices enforces firm scoping.
  const rows = await db
    .select({
      total: sql<string>`COALESCE(SUM(${invoiceLineItems.amountCents}), 0)::text`,
    })
    .from(invoiceLineItems)
    .innerJoin(invoices, eq(invoices.id, invoiceLineItems.invoiceId))
    .where(
      and(
        eq(invoiceLineItems.engagementId, engagementId),
        eq(invoices.firmId, firmId),
        isNotNull(invoices.sentAt),
      ),
    );
  const raw = rows[0]?.total ?? '0';
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function createWipRouter(deps: WipRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get(
    '/:engagementId',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const engagementId = req.params['engagementId']!;
      // Load engagement + assert firm scope via the client join.
      const engRow = await deps.db
        .select({
          id: engagements.id,
          name: engagements.name,
          feeStructure: engagements.feeStructure,
          feeAmountCents: engagements.feeAmountCents,
          clientFirmId: clients.firmId,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(engagements.id, engagementId))
        .limit(1);
      const eng = engRow[0];
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      if (eng.clientFirmId !== session.firmId) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }

      const entryRows = await deps.db
        .select({
          appUserId: timeEntries.appUserId,
          workCodeId: timeEntries.workCodeId,
          hours: timeEntries.hours,
          standardRateSnapshotCents: timeEntries.standardRateSnapshotCents,
          billableFlag: timeEntries.billableFlag,
          inScopeFlag: timeEntries.inScopeFlag,
          outOfScopeOverride: timeEntries.outOfScopeOverride,
        })
        .from(timeEntries)
        .where(eq(timeEntries.engagementId, engagementId));

      const entries: TimeEntryForWip[] = entryRows.map((r) => ({
        appUserId: r.appUserId,
        workCodeId: r.workCodeId,
        hours: r.hours,
        standardRateSnapshotCents: r.standardRateSnapshotCents,
        billableFlag: r.billableFlag,
        inScopeFlag: r.inScopeFlag,
        outOfScopeOverride: r.outOfScopeOverride,
      }));

      const billedCents = await loadBilledCents(deps.db, engagementId, session.firmId);
      const rollup = rollUpEngagementWip({
        feeStructure: eng.feeStructure as WipFeeStructure,
        feeAmountCents: eng.feeAmountCents,
        billedCents,
        entries,
      });

      // Resolve names for the projection (only the ids that appear in
      // the rollup, no broader fetch).
      const userIds = rollup.byUser.map((u) => u.appUserId);
      const userNameMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const userRows = await deps.db
          .select({ id: appUsers.id, fullName: appUsers.fullName })
          .from(appUsers)
          .where(eq(appUsers.firmId, session.firmId));
        for (const u of userRows) {
          if (userIds.includes(u.id)) userNameMap[u.id] = u.fullName;
        }
      }
      const wcIds = rollup.byWorkCode.flatMap((w) => (w.workCodeId ? [w.workCodeId] : []));
      const wcNameMap: Record<string, string> = {};
      if (wcIds.length > 0) {
        const wcRows = await deps.db
          .select({ id: workCodes.id, name: workCodes.name })
          .from(workCodes)
          .where(eq(workCodes.firmId, session.firmId));
        for (const w of wcRows) {
          if (wcIds.includes(w.id)) wcNameMap[w.id] = w.name;
        }
      }

      if (req.query['format'] === 'csv') {
        const csv = wipRollupToCsv(rollup, {
          engagementName: eng.name,
          feeStructure: eng.feeStructure as WipFeeStructure,
          feeAmountCents: eng.feeAmountCents,
          userNames: userNameMap,
          workCodeNames: wcNameMap,
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="wip-${engagementId}.csv"`);
        res.send(csv);
        return;
      }

      res.json({
        engagement: {
          id: eng.id,
          name: eng.name,
          feeStructure: eng.feeStructure,
          feeAmountCents: eng.feeAmountCents,
        },
        billedCents,
        rollup: {
          totalHours: rollup.totalHours,
          wipCents: rollup.wipCents,
          billableWipCents: rollup.billableWipCents,
          inScopeWipCents: rollup.inScopeWipCents,
          realizationBps: rollup.realizationBps,
          realizationBasis: rollup.realizationBasis,
          byUser: rollup.byUser.map((u) => ({
            ...u,
            name: userNameMap[u.appUserId] ?? null,
          })),
          byWorkCode: rollup.byWorkCode.map((w) => ({
            ...w,
            name: w.workCodeId ? (wcNameMap[w.workCodeId] ?? null) : null,
          })),
        },
      });
    },
  );

  return router;
}
