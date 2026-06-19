// SPDX-License-Identifier: Elastic-2.0
//
// Reporting endpoints — Phase 17. Realization rollups straight off
// `adjustment_allocation`. No materialized view yet — the query joins to
// engagement→client to scope by firm and groups in SQL, then rolls per
// dimension via @vibe/core/reporting.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  adjustmentAllocations,
  adjustments,
  appUsers,
  approvalRequests,
  billingBatches,
  clients,
  engagementTypes,
  engagements,
  firmSettings,
  invoiceLineItems,
  invoices,
  payments,
  recurringBillingPlans,
  serviceLines,
  timeEntries,
} from '@vibe/db/schema';
import {
  clientRequestBillableCaptureRate,
  rollup,
  rollupBy,
  type AllocationRow,
} from '@vibe/core/reporting';
import { clientRequestTimeEntryLinks, clientRequests } from '@vibe/db/schema';
import { sql as drz } from 'drizzle-orm';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { csvField } from '../lib/csv';
import { namesByIds } from './names';

export interface ReportRoutesDeps extends RbacDeps {
  db: Database | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QuerySchema = z.object({
  // 'service_line' rolls allocations up by engagement_type.service_line_id;
  // engagements without an assigned type are excluded from this dimension.
  dimension: z.enum(['firm', 'timekeeper', 'engagement', 'client', 'service_line']).default('firm'),
  start: z.string().regex(DATE_RE).optional(),
  end: z.string().regex(DATE_RE).optional(),
  // Drill filters (Phase 17 #20). When provided, the rollup is scoped
  // to the matching subset before grouping; lets the UI follow
  // firm → timekeeper → engagement.
  appUserId: z.string().uuid().optional(),
  engagementId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  // Service-line drill filters. Both narrow the allocation set before
  // grouping. `serviceLineId` is exact; `serviceLineCategory` matches
  // the firm-managed category text (0148 — was a five-value enum).
  serviceLineId: z.string().uuid().optional(),
  serviceLineCategory: z.string().trim().min(1).max(40).toLowerCase().optional(),
  // v2 followup — CSV export (workstream 4). When format=csv the
  // response body is text/csv instead of JSON, same shape otherwise.
  format: z.enum(['json', 'csv']).default('json'),
});

function csvCell(s: string | number | null | undefined): string {
  return csvField(s);
}

// Attribute invoice revenue to engagements. A CONSOLIDATED invoice (one
// invoice spanning several engagements via line items) is split by each
// engagement's share of the engagement-tagged line-item amounts; a simple
// invoice (0–1 tagged engagement) falls back to the header total on the
// primary-engagement pointer, preserving the fee-inclusive single case.
// Excludes DRAFT (not yet real revenue) and VOIDED (reversed) invoices.
async function billedByEngagement(
  db: Database,
  firmId: string,
  engIdSet: Set<string>,
): Promise<Map<string, { billed: number; paid: number }>> {
  const billedBy = new Map<string, { billed: number; paid: number }>();
  if (engIdSet.size === 0) return billedBy;
  const firmInvoices = await db
    .select({
      id: invoices.id,
      primaryEngagementId: invoices.primaryEngagementId,
      totalCents: invoices.totalCents,
      paidCents: invoices.paidCents,
    })
    .from(invoices)
    .where(and(eq(invoices.firmId, firmId), notInArray(invoices.status, ['DRAFT', 'VOIDED'])));
  const invIds = firmInvoices.map((i) => i.id);
  const liRows = invIds.length
    ? await db
        .select({
          invoiceId: invoiceLineItems.invoiceId,
          engagementId: invoiceLineItems.engagementId,
          amountCents: invoiceLineItems.amountCents,
        })
        .from(invoiceLineItems)
        .where(inArray(invoiceLineItems.invoiceId, invIds))
    : [];
  const linesByInvoice = new Map<string, Map<string, number>>();
  for (const li of liRows) {
    if (!li.engagementId || !engIdSet.has(li.engagementId)) continue;
    const byEng = linesByInvoice.get(li.invoiceId) ?? new Map<string, number>();
    byEng.set(li.engagementId, (byEng.get(li.engagementId) ?? 0) + Number(li.amountCents));
    linesByInvoice.set(li.invoiceId, byEng);
  }
  const add = (engId: string, billed: number, paid: number) => {
    const cur = billedBy.get(engId) ?? { billed: 0, paid: 0 };
    cur.billed += billed;
    cur.paid += paid;
    billedBy.set(engId, cur);
  };
  for (const invRow of firmInvoices) {
    const total = Number(invRow.totalCents);
    const paid = Number(invRow.paidCents);
    const byEng = linesByInvoice.get(invRow.id);
    if (!byEng || byEng.size <= 1) {
      const [onlyEng] = byEng ? Array.from(byEng.keys()) : [];
      const targetEng = onlyEng ?? invRow.primaryEngagementId;
      if (targetEng && engIdSet.has(targetEng)) add(targetEng, total, paid);
      continue;
    }
    const attributed = Array.from(byEng.values()).reduce((a, b) => a + b, 0);
    if (attributed <= 0) {
      if (invRow.primaryEngagementId && engIdSet.has(invRow.primaryEngagementId))
        add(invRow.primaryEngagementId, total, paid);
      continue;
    }
    for (const [engId, amt] of byEng) {
      const share = amt / attributed;
      add(engId, Math.round(total * share), Math.round(paid * share));
    }
  }
  return billedBy;
}

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
      // Pull engagements with their service-line dimension already joined,
      // so service-line filters + the new dimension keyFn don't need a
      // separate roundtrip per allocation. Left-joins because not every
      // engagement has an engagement_type / service_line set.
      const firmEngagements = await deps.db
        .select({
          id: engagements.id,
          clientId: engagements.clientId,
          serviceLineId: serviceLines.id,
          serviceLineCategory: serviceLines.category,
        })
        .from(engagements)
        .leftJoin(engagementTypes, eq(engagementTypes.id, engagements.engagementTypeId))
        .leftJoin(serviceLines, eq(serviceLines.id, engagementTypes.serviceLineId))
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

      // Date filter (#28) + drill filters (#20): always join to
      // time_entries so we can scope on entry date and drill into
      // specific timekeepers/engagements/clients.
      // Scope to this firm's billing batches in SQL (not merely via the JS
      // filter below), and count only APPLIED adjustments. Allocation rows
      // are written while an adjustment is still PENDING_APPROVAL, and a
      // reversal flips status to REVERSED without deleting allocations — so
      // both would otherwise pollute realization with non-realized billing.
      const conds = [
        inArray(
          adjustments.billingBatchId,
          firmBatches.map((b) => b.id),
        ),
        eq(adjustments.status, 'APPLIED'),
      ];
      if (parsed.data.start)
        conds.push(drz`${timeEntries.entryDate} >= ${parsed.data.start}::date`);
      if (parsed.data.end) conds.push(drz`${timeEntries.entryDate} <= ${parsed.data.end}::date`);
      if (parsed.data.appUserId)
        conds.push(eq(adjustmentAllocations.appUserId, parsed.data.appUserId));
      if (parsed.data.engagementId)
        conds.push(eq(billingBatches.engagementId, parsed.data.engagementId));
      const rows = await deps.db
        .select({
          appUserId: adjustmentAllocations.appUserId,
          timeEntryId: adjustmentAllocations.timeEntryId,
          originalValueCents: adjustmentAllocations.originalValueCents,
          adjustedValueCents: adjustmentAllocations.adjustedValueCents,
          engagementId: billingBatches.engagementId,
          entryDate: timeEntries.entryDate,
        })
        .from(adjustmentAllocations)
        // allocation → adjustment → billing_batch. adjustment_allocations.adjustment_id
        // is an adjustments.id (NOT a billing_batch id), so we must hop through the
        // adjustments table to reach the batch and its engagement.
        .innerJoin(adjustments, eq(adjustments.id, adjustmentAllocations.adjustmentId))
        .innerJoin(billingBatches, eq(billingBatches.id, adjustments.billingBatchId))
        .innerJoin(timeEntries, eq(timeEntries.id, adjustmentAllocations.timeEntryId))
        .where(and(...conds));

      const enginToClient = new Map(firmEngagements.map((e) => [e.id, e.clientId]));
      // Service-line lookup map — populated for engagements that have an
      // assigned type with a service line. Engagements without one stay
      // absent, which naturally drops them from service-line filters and
      // the service_line dimension.
      const enginToServiceLine = new Map<string, { serviceLineId: string; category: string }>();
      for (const e of firmEngagements) {
        if (e.serviceLineId && e.serviceLineCategory) {
          enginToServiceLine.set(e.id, {
            serviceLineId: e.serviceLineId,
            category: e.serviceLineCategory,
          });
        }
      }
      const allocationRows: AllocationRow[] = rows
        .filter((r) => enginToClient.has(r.engagementId))
        .filter(
          (r) =>
            !parsed.data.clientId || enginToClient.get(r.engagementId) === parsed.data.clientId,
        )
        .filter((r) => {
          if (!parsed.data.serviceLineId) return true;
          return (
            enginToServiceLine.get(r.engagementId)?.serviceLineId === parsed.data.serviceLineId
          );
        })
        .filter((r) => {
          if (!parsed.data.serviceLineCategory) return true;
          return (
            enginToServiceLine.get(r.engagementId)?.category === parsed.data.serviceLineCategory
          );
        })
        .map((r) => ({
          appUserId: r.appUserId,
          engagementId: r.engagementId,
          clientId: enginToClient.get(r.engagementId)!,
          originalValueCents: r.originalValueCents,
          adjustedValueCents: r.adjustedValueCents,
        }));

      if (parsed.data.dimension === 'firm') {
        const summary = rollup(allocationRows);
        if (parsed.data.format === 'csv') {
          const lines = [
            ['dimension', 'original_cents', 'adjusted_cents', 'realization_pct'].join(','),
            [
              'firm',
              summary.originalValueCents,
              summary.adjustedValueCents,
              summary.realizationPct,
            ].join(','),
          ];
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="realization-firm-${new Date().toISOString().slice(0, 10)}.csv"`,
          );
          res.send(lines.join('\n') + '\n');
          return;
        }
        res.json({ dimension: 'firm', summary });
        return;
      }

      const keyFn = {
        timekeeper: (r: AllocationRow) => r.appUserId,
        engagement: (r: AllocationRow) => r.engagementId,
        client: (r: AllocationRow) => r.clientId,
        // Engagements without a service line fall into a sentinel
        // "__unassigned__" bucket so the rollup is total-preserving.
        service_line: (r: AllocationRow) =>
          enginToServiceLine.get(r.engagementId)?.serviceLineId ?? '__unassigned__',
      }[parsed.data.dimension];
      const map = rollupBy(allocationRows, keyFn);

      // Enrich rows with labels so the UI can render a name and drill
      // (Phase 17 #20). Timekeeper → full name, engagement → name,
      // client → name.
      let nameMap = new Map<string, string>();
      const ids = Array.from(map.keys());
      if (ids.length > 0) {
        if (parsed.data.dimension === 'timekeeper') {
          const people = await deps.db
            .select({ id: appUsers.id, fullName: appUsers.fullName })
            .from(appUsers)
            .where(inArray(appUsers.id, ids));
          nameMap = new Map(people.map((p) => [p.id, p.fullName]));
        } else if (parsed.data.dimension === 'engagement') {
          const engs = await deps.db
            .select({ id: engagements.id, name: engagements.name })
            .from(engagements)
            .where(inArray(engagements.id, ids));
          nameMap = new Map(engs.map((e) => [e.id, e.name]));
        } else if (parsed.data.dimension === 'client') {
          const cls = await deps.db
            .select({ id: clients.id, name: clients.name })
            .from(clients)
            .where(inArray(clients.id, ids));
          nameMap = new Map(cls.map((c) => [c.id, c.name]));
        } else if (parsed.data.dimension === 'service_line') {
          // Translate ids (minus the unassigned sentinel) to friendly
          // labels "<name> (<category>)".
          const realIds = ids.filter((id) => id !== '__unassigned__');
          const slRows = realIds.length
            ? await deps.db
                .select({
                  id: serviceLines.id,
                  name: serviceLines.name,
                  category: serviceLines.category,
                })
                .from(serviceLines)
                .where(inArray(serviceLines.id, realIds))
            : [];
          nameMap = new Map(slRows.map((sl) => [sl.id, `${sl.name} (${sl.category})`]));
          if (map.has('__unassigned__')) {
            nameMap.set('__unassigned__', '(No service line)');
          }
        }
      }

      const items = Array.from(map.entries())
        .map(([key, value]) => ({
          key,
          label: nameMap.get(key) ?? null,
          ...value,
        }))
        .sort((a, b) => a.realizationPct - b.realizationPct);
      if (parsed.data.format === 'csv') {
        const header = ['key', 'label', 'original_cents', 'adjusted_cents', 'realization_pct'];
        const lines = [header.join(',')];
        for (const it of items) {
          lines.push(
            [
              csvCell(it.key),
              csvCell(it.label ?? ''),
              csvCell(it.originalValueCents),
              csvCell(it.adjustedValueCents),
              csvCell(it.realizationPct),
            ].join(','),
          );
        }
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="realization-${parsed.data.dimension}-${new Date()
            .toISOString()
            .slice(0, 10)}.csv"`,
        );
        res.send(lines.join('\n') + '\n');
        return;
      }
      res.json({ dimension: parsed.data.dimension, items });
    },
  );

  router.get(
    '/realization-by-partner',
    requirePermission(deps, 'report:partner-data:read'),
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
      const batchIds = batches.map((b) => b.id);
      const rows = batchIds.length
        ? await deps.db
            .select({
              // The batch id lives on the adjustment, not the allocation — join
              // through adjustments to recover it (adjustment_id ≠ billing_batch id).
              batchId: adjustments.billingBatchId,
              original: adjustmentAllocations.originalValueCents,
              adjusted: adjustmentAllocations.adjustedValueCents,
            })
            .from(adjustmentAllocations)
            .innerJoin(adjustments, eq(adjustments.id, adjustmentAllocations.adjustmentId))
            // Scope to this firm's batches in SQL, and only realized (APPLIED)
            // adjustments — mirrors /realization.
            .where(
              and(inArray(adjustments.billingBatchId, batchIds), eq(adjustments.status, 'APPLIED')),
            )
        : [];
      const byPartner = new Map<string, { originalCents: number; adjustedCents: number }>();
      for (const r of rows) {
        const engId = engByBatch.get(r.batchId);
        if (!engId) continue;
        const partnerId = partnerByEng.get(engId);
        if (!partnerId) continue;
        const cur = byPartner.get(partnerId) ?? { originalCents: 0, adjustedCents: 0 };
        cur.originalCents += Number(r.original);
        cur.adjustedCents += Number(r.adjusted);
        byPartner.set(partnerId, cur);
      }
      const partnerNames = await namesByIds(deps.db, Array.from(byPartner.keys()), 'partner');
      res.json({
        items: Array.from(byPartner.entries()).map(([partnerId, v]) => ({
          partnerId,
          partnerName: partnerNames.get(partnerId) ?? null,
          originalCents: v.originalCents,
          adjustedCents: v.adjustedCents,
          // 0–1 ratio, consistent with /realization (was 0–100 here).
          realizationPct: v.originalCents > 0 ? v.adjustedCents / v.originalCents : 0,
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
      // Profit per engagement: SUM(invoice.total) − SUM(time_entry.hours
      // × cost_rate_snapshot_cents). 0063 added cost_rate_snapshot_cents
      // on time_entry so no LATERAL join against staff_rate_snapshot is
      // needed. Engagements with no time entries roll up cost=0; ones
      // with no invoices roll up billed=0.
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
      if (engIds.length === 0) {
        res.json({ items: [] });
        return;
      }
      const engIdSet = new Set(engIds);
      const [billedBy, cost] = await Promise.all([
        billedByEngagement(deps.db, session.firmId, engIdSet),
        deps.db
          .select({
            engagementId: timeEntries.engagementId,
            costCents: drz<number>`COALESCE(SUM(${timeEntries.hours}::numeric * COALESCE(${timeEntries.costRateSnapshotCents}, 0)), 0)::bigint`,
          })
          .from(timeEntries)
          // Exclude soft-deleted (ARCHIVED) entries from the cost base.
          .where(and(inArray(timeEntries.engagementId, engIds), ne(timeEntries.status, 'ARCHIVED')))
          .groupBy(timeEntries.engagementId),
      ]);
      const costBy = new Map<string, number>();
      for (const r of cost) {
        costBy.set(r.engagementId, Number(r.costCents));
      }
      const allEngIds = new Set<string>([...billedBy.keys(), ...costBy.keys()]);
      const items = Array.from(allEngIds).map((engId) => {
        const br = billedBy.get(engId) ?? { billed: 0, paid: 0 };
        const cc = costBy.get(engId) ?? 0;
        const marginCents = br.billed - cc;
        return {
          engagementId: engId,
          billedCents: br.billed,
          paidCents: br.paid,
          costCents: cc,
          marginCents,
          marginPct: br.billed > 0 ? (marginCents / br.billed) * 100 : null,
        };
      });
      res.json({ items });
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
        // Exclude DRAFT (not yet real revenue) and VOIDED (reversed) invoices.
        .where(and(eq(inv.firmId, session.firmId), notInArray(inv.status, ['DRAFT', 'VOIDED'])))
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
          standardHoursPerWeek: au.standardHoursPerWeek,
        })
        .from(te)
        .innerJoin(au, eq(au.id, te.appUserId))
        .where(
          and(
            eq(au.firmId, session.firmId),
            // Exclude soft-deleted (ARCHIVED) entries.
            ne(te.status, 'ARCHIVED'),
            drz`${te.entryDate} >= ${since}::date`,
          ),
        )
        .groupBy(te.appUserId, au.fullName, au.standardHoursPerWeek);
      res.json({
        asOf: new Date().toISOString().slice(0, 10),
        windowDays: 30,
        items: rows.map((r) => {
          const billable = Number(r.billableHours);
          const total = Number(r.totalHours);
          // Capacity over the 30-day window = standard weekly hours × 30/7.
          const availableHours =
            Math.round(((Number(r.standardHoursPerWeek) * 30) / 7) * 100) / 100;
          return {
            appUserId: r.appUserId,
            fullName: r.fullName,
            billableHours: billable,
            totalHours: total,
            // Share of LOGGED time that is billable (billable / total).
            utilizationPct: total > 0 ? (billable / total) * 100 : 0,
            // Billable hours against available CAPACITY (billable / available)
            // — the truer "utilization" for a timekeeper who under-logs.
            availableHours,
            capacityUtilizationPct: availableHours > 0 ? (billable / availableHours) * 100 : 0,
          };
        }),
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
        // Exclude soft-deleted (ARCHIVED) entries.
        .where(and(inArray(te.engagementId, engIds), ne(te.status, 'ARCHIVED')))
        .groupBy(te.engagementId);
      const tbeEngNames = await namesByIds(
        deps.db,
        rows.map((r) => r.engagementId),
        'engagement',
      );
      res.json({
        items: rows.map((r) => ({
          engagementId: r.engagementId,
          engagementName: r.engagementId ? (tbeEngNames.get(r.engagementId) ?? null) : null,
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
        // Exclude soft-deleted (ARCHIVED) entries.
        .where(and(inArray(te.engagementId, engIds), ne(te.status, 'ARCHIVED')))
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
      const tbcClientNames = await namesByIds(deps.db, Array.from(byClient.keys()), 'client');
      res.json({
        items: Array.from(byClient.entries()).map(([clientId, v]) => ({
          clientId,
          clientName: tbcClientNames.get(clientId) ?? null,
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
              // Recover the batch id from the adjustment (adjustment_id ≠ batch id).
              billingBatchId: adjustments.billingBatchId,
            })
            .from(adjustmentAllocations)
            .innerJoin(adjustments, eq(adjustments.id, adjustmentAllocations.adjustmentId))
            // SECURITY: scope to THIS firm's batches in SQL. Without this the
            // query read every firm's allocations and emitted the unmatched
            // ones (blank engagement/client but real appUserId + dollar
            // amounts) — a cross-firm data leak. Also restrict to APPLIED.
            .where(
              and(inArray(adjustments.billingBatchId, batchIds), eq(adjustments.status, 'APPLIED')),
            )
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
        const engId = batchToEng.get(r.billingBatchId);
        // Defense-in-depth: skip any row whose batch isn't in this firm's set
        // (the SQL scope above already guarantees this, but never emit a row
        // we can't attribute to a firm engagement/client).
        if (!engId) continue;
        const cliId = engToClient.get(engId) ?? '';
        const orig = Number(r.originalValueCents);
        const adj = Number(r.adjustedValueCents);
        // 0–1 ratio to match the JSON /realization endpoint.
        const pct = orig > 0 ? (adj / orig).toFixed(4) : '0';
        lines.push(
          [csvField(r.appUserId), csvField(engId), csvField(cliId), orig, adj, pct].join(','),
        );
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
          and(
            eq(invoices.firmId, session.firmId),
            // Sales basis must exclude DRAFT (not billed) + VOIDED (reversed)
            // so it stays consistent with the AR (outstanding) basis below.
            notInArray(invoices.status, ['DRAFT', 'VOIDED']),
            drz`${invoices.issueDate} >= ${since}::date`,
          ),
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
            // Exclude voided payments (a voided manual payment can still be
            // SUCCEEDED) from the collected total.
            isNull(payments.voidedAt),
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

      // Phase 17 #27 — prior-period comparison overlay. Compute the
      // SAME window shifted back by `days` so the delta is apples-to-
      // apples (90d-vs-90d, not month-vs-month).
      const priorEnd = new Date(Date.now() - days * 86_400_000);
      const priorStart = new Date(Date.now() - 2 * days * 86_400_000);
      const priorStartStr = priorStart.toISOString().slice(0, 10);
      const priorEndStr = priorEnd.toISOString().slice(0, 10);
      const [priorBilled] = await deps.db
        .select({ t: drz<number>`COALESCE(SUM(${invoices.totalCents}), 0)` })
        .from(invoices)
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            notInArray(invoices.status, ['DRAFT', 'VOIDED']),
            drz`${invoices.issueDate} >= ${priorStartStr}::date`,
            drz`${invoices.issueDate} < ${priorEndStr}::date`,
          ),
        );
      const [priorPaid] = await deps.db
        .select({
          t: drz<number>`COALESCE(SUM(${payments.amountCents} - COALESCE(${payments.refundedAmountCents}, 0)), 0)`,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            eq(payments.status, 'SUCCEEDED'),
            isNull(payments.voidedAt),
            drz`${payments.receivedAt} >= ${priorStartStr}::timestamptz`,
            drz`${payments.receivedAt} < ${priorEndStr}::timestamptz`,
          ),
        );
      const priorBilledT = Number(priorBilled?.t ?? 0);
      const priorPaidT = Number(priorPaid?.t ?? 0);

      res.json({
        windowDays: days,
        billedCents: billedT,
        paidCents: paidT,
        outstandingCents: outstandingT,
        dsoDays,
        collectionRatePct,
        prior: {
          billedCents: priorBilledT,
          paidCents: priorPaidT,
          collectionRatePct: priorBilledT > 0 ? (priorPaidT / priorBilledT) * 100 : null,
          windowStart: priorStartStr,
          windowEnd: priorEndStr,
        },
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
          and(
            eq(invoices.firmId, session.firmId),
            notInArray(invoices.status, ['DRAFT', 'VOIDED']),
            drz`${invoices.issueDate} >= ${since}::date`,
          ),
        )
        .groupBy(clients.partnerInChargeId);
      const crPartnerNames = await namesByIds(
        deps.db,
        rows.map((r) => r.partnerId),
        'partner',
      );
      res.json({
        windowDays: 90,
        items: rows.map((r) => {
          const b = Number(r.billed);
          const p = Number(r.paid);
          return {
            partnerId: r.partnerId,
            partnerName: r.partnerId ? (crPartnerNames.get(r.partnerId) ?? null) : null,
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
      // Billed (post-write-down) value per time entry: the APPLIED adjusted
      // value where the entry was adjusted, otherwise its standard amount. A
      // time entry belongs to a single billing batch/adjustment, so the SUM
      // collapses to that one applied allocation.
      const appliedAdjusted = deps.db
        .select({
          timeEntryId: adjustmentAllocations.timeEntryId,
          adjustedCents: drz<number>`SUM(${adjustmentAllocations.adjustedValueCents})`.as(
            'adjusted_cents',
          ),
        })
        .from(adjustmentAllocations)
        .innerJoin(adjustments, eq(adjustments.id, adjustmentAllocations.adjustmentId))
        .where(eq(adjustments.status, 'APPLIED'))
        .groupBy(adjustmentAllocations.timeEntryId)
        .as('applied_adjusted');
      const rows = await deps.db
        .select({
          appUserId: timeEntries.appUserId,
          fullName: appUsers.fullName,
          // Effective rate = billed value / billable hours. Both numerator and
          // denominator filter to billable so the rate isn't deflated by
          // non-billable time (was: standard value over ALL hours).
          hours: drz<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.billableFlag}), 0)`,
          amountCents: drz<number>`COALESCE(SUM(COALESCE(${appliedAdjusted.adjustedCents}, ${timeEntries.standardAmountCents})) FILTER (WHERE ${timeEntries.billableFlag}), 0)`,
        })
        .from(timeEntries)
        .innerJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .leftJoin(appliedAdjusted, eq(appliedAdjusted.timeEntryId, timeEntries.id))
        .where(
          and(
            eq(appUsers.firmId, session.firmId),
            ne(timeEntries.status, 'ARCHIVED'),
            drz`${timeEntries.entryDate} >= ${since}::date`,
          ),
        )
        .groupBy(timeEntries.appUserId, appUsers.fullName);
      res.json({
        windowDays: 90,
        items: rows.map((r) => {
          const h = Number(r.hours);
          // Billed (post-adjustment) value of billable work for this user.
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
        // Exclude DRAFT (not yet real revenue) and VOIDED (reversed) invoices.
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            notInArray(invoices.status, ['DRAFT', 'VOIDED']),
          ),
        )
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
          case 'SEMIANNUAL':
            return Math.round(amount / 6);
          case 'ANNUAL':
            return Math.round(amount / 12);
          default:
            // Unknown cadence: don't assume monthly (that masked the missing
            // SEMIANNUAL case and overstated semiannual plans 6×).
            return 0;
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
    requirePermission(deps, 'report:partner-data:read'),
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
          and(
            eq(invoices.clientId, clients.id),
            notInArray(invoices.status, ['DRAFT', 'VOIDED']),
            drz`${invoices.issueDate} >= ${since}::date`,
          ),
        )
        // A partner's "book" is their ACTIVE clients — exclude archived.
        .where(and(eq(clients.firmId, session.firmId), ne(clients.status, 'ARCHIVED')))
        .groupBy(clients.partnerInChargeId);
      const bobPartnerNames = await namesByIds(
        deps.db,
        rows.map((r) => r.partnerId),
        'partner',
      );
      res.json({
        windowDays: 365,
        items: rows.map((r) => ({
          partnerId: r.partnerId,
          partnerName: r.partnerId ? (bobPartnerNames.get(r.partnerId) ?? null) : null,
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
        // Exclude DRAFT (not yet real revenue) and VOIDED (reversed) invoices.
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            notInArray(invoices.status, ['DRAFT', 'VOIDED']),
          ),
        )
        .groupBy(invoices.clientId)
        .orderBy(drz`COALESCE(SUM(${invoices.paidCents}), 0) DESC`)
        .limit(200);
      const clvClientNames = await namesByIds(
        deps.db,
        rows.map((r) => r.clientId),
        'client',
      );
      res.json({
        items: rows.map((r) => ({
          clientId: r.clientId,
          clientName: r.clientId ? (clvClientNames.get(r.clientId) ?? null) : null,
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
    requirePermission(deps, 'report:partner-data:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], totals: null });
        return;
      }
      // 0063 — cost is now snapshotted on time_entry.cost_rate_snapshot_cents.
      // No more correlated SELECT against staff_rate_snapshot at read
      // time; historical profitability is locked at the write moment.
      const rows = await deps.db
        .select({
          engagementId: engagements.id,
          engagementName: engagements.name,
          clientName: clients.name,
          costCents: drz<number>`COALESCE(SUM(${timeEntries.hours}::numeric * COALESCE(${timeEntries.costRateSnapshotCents}, 0)), 0)::bigint`,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        // Exclude soft-deleted (ARCHIVED) entries from the cost base.
        .leftJoin(
          timeEntries,
          and(eq(timeEntries.engagementId, engagements.id), ne(timeEntries.status, 'ARCHIVED')),
        )
        .where(and(eq(clients.firmId, session.firmId)))
        .groupBy(engagements.id, engagements.name, clients.name);
      // Attribute revenue per engagement (consolidated invoices split by line
      // item; DRAFT/VOIDED excluded) — same helper as /profitability.
      const billMap = await billedByEngagement(
        deps.db,
        session.firmId,
        new Set(rows.map((r) => r.engagementId)),
      );
      const items = rows
        .map((r) => {
          const inv = billMap.get(r.engagementId);
          const billedCents = inv ? inv.billed : 0;
          const paidCents = inv ? inv.paid : 0;
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
          standardHoursPerWeek: appUsers.standardHoursPerWeek,
          totalBillableHours: drz<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.billableFlag} = true), 0)`,
        })
        .from(timeEntries)
        .innerJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .where(
          and(
            eq(appUsers.firmId, session.firmId),
            // Exclude soft-deleted (ARCHIVED) entries.
            ne(timeEntries.status, 'ARCHIVED'),
            drz`${timeEntries.entryDate} >= ${since}::date`,
          ),
        )
        .groupBy(timeEntries.appUserId, appUsers.fullName, appUsers.standardHoursPerWeek);
      // 90 days ≈ 13 weeks; weekly average × 4 weeks = projection.
      res.json({
        weeklyTargetHours: weeklyTarget,
        projectionWeeks: 4,
        items: rows.map((r) => {
          const billable = Number(r.totalBillableHours);
          const weeklyAvg = billable / 13;
          const projectedNext4Weeks = weeklyAvg * 4;
          // Per-user capacity basis (their standard work week) alongside the
          // flat firm-wide weeklyTarget — a more honest variance than a single
          // global number for everyone.
          const standardWeeklyHours = Number(r.standardHoursPerWeek);
          return {
            appUserId: r.appUserId,
            fullName: r.fullName,
            trailing90Hours: billable,
            weeklyAvgHours: weeklyAvg,
            projectedNext4Weeks,
            varianceVsTarget: projectedNext4Weeks - weeklyTarget * 4,
            standardWeeklyHours,
            varianceVsCapacity: projectedNext4Weeks - standardWeeklyHours * 4,
            capacityUtilizationPct:
              standardWeeklyHours > 0 ? (weeklyAvg / standardWeeklyHours) * 100 : 0,
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
          and(
            eq(appUsers.firmId, session.firmId),
            // Exclude soft-deleted (ARCHIVED) entries.
            ne(timeEntries.status, 'ARCHIVED'),
            drz`${timeEntries.entryDate} >= ${since}::date`,
          ),
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
      // Phase 20 #8 — pick firm default from firm_settings, allow per-user
      // override on app_user.billable_target_hours_per_month. ?target=
      // query still overrides everything for ad-hoc what-if reports.
      const [fs] = await deps.db
        .select({ firmTarget: firmSettings.billableTargetHoursPerMonth })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, session.firmId))
        .limit(1);
      const queryTarget = parseFloat(String(req.query['target'] ?? ''));
      const fallbackTarget =
        !Number.isNaN(queryTarget) && queryTarget > 0 ? queryTarget : (fs?.firmTarget ?? 130);
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        .toISOString()
        .slice(0, 10);
      // Fraction of the current month elapsed (inclusive of today), used to
      // prorate the full-month target so month-to-date hours aren't compared
      // against a whole-month figure (which reads ~0% early in the month).
      const daysInMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const monthElapsedFraction = now.getUTCDate() / daysInMonth;
      const rows = await deps.db
        .select({
          appUserId: timeEntries.appUserId,
          fullName: appUsers.fullName,
          userTarget: appUsers.billableTargetHoursPerMonth,
          billableHours: drz<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.billableFlag} = true), 0)`,
        })
        .from(timeEntries)
        .innerJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
        .where(
          and(
            eq(appUsers.firmId, session.firmId),
            // Exclude soft-deleted (ARCHIVED) entries.
            ne(timeEntries.status, 'ARCHIVED'),
            drz`${timeEntries.entryDate} >= ${monthStart}::date`,
          ),
        )
        .groupBy(timeEntries.appUserId, appUsers.fullName, appUsers.billableTargetHoursPerMonth);
      res.json({
        targetHours: fallbackTarget,
        monthStart,
        monthElapsedPct: Math.round(monthElapsedFraction * 1000) / 10,
        items: rows.map((r) => {
          const billable = Number(r.billableHours);
          const target = r.userTarget ?? fallbackTarget;
          // Prorated target = full-month target × fraction of month elapsed.
          const proratedTarget = Math.round(target * monthElapsedFraction * 100) / 100;
          return {
            appUserId: r.appUserId,
            fullName: r.fullName,
            billableHours: billable,
            targetHours: target,
            varianceHours: billable - target,
            attainmentPct: target > 0 ? (billable / target) * 100 : 0,
            // Month-to-date view: hours vs the prorated target.
            proratedTargetHours: proratedTarget,
            proratedAttainmentPct: proratedTarget > 0 ? (billable / proratedTarget) * 100 : 0,
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
          // Effective out-of-scope (schema rule) = NOT(inScopeFlag AND NOT
          // outOfScopeOverride) = NOT inScopeFlag OR outOfScopeOverride. The
          // user veto (outOfScopeOverride) was previously ignored.
          outOfScopeHours: drz<string>`COALESCE(SUM(${timeEntries.hours}) FILTER (WHERE ${timeEntries.inScopeFlag} = false OR ${timeEntries.outOfScopeOverride} = true), 0)`,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        // Exclude soft-deleted (ARCHIVED) entries.
        .leftJoin(
          timeEntries,
          and(eq(timeEntries.engagementId, engagements.id), ne(timeEntries.status, 'ARCHIVED')),
        )
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

  // -------------------------------------------------------------------
  // Approval metrics (Phase 18 #20): per-approver counts + average
  // response time + approval/rejection rates over the last N days.
  // -------------------------------------------------------------------
  router.get(
    '/approval-metrics',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const days = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '90'), 10) || 90, 7),
        365,
      );
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await deps.db
        .select({
          approverId: approvalRequests.approverId,
          fullName: appUsers.fullName,
          total: drz<number>`COUNT(*)`,
          approved: drz<number>`COUNT(*) FILTER (WHERE ${approvalRequests.status} IN ('APPROVED', 'APPROVED_WITH_EDITS'))`,
          rejected: drz<number>`COUNT(*) FILTER (WHERE ${approvalRequests.status} = 'REJECTED')`,
          pending: drz<number>`COUNT(*) FILTER (WHERE ${approvalRequests.status} = 'PENDING')`,
          avgResponseSeconds: drz<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${approvalRequests.respondedAt} - ${approvalRequests.requestedAt}))) FILTER (WHERE ${approvalRequests.respondedAt} IS NOT NULL), 0)`,
        })
        .from(approvalRequests)
        .leftJoin(appUsers, eq(appUsers.id, approvalRequests.approverId))
        .where(
          and(
            eq(appUsers.firmId, session.firmId),
            drz`${approvalRequests.requestedAt} >= ${since.toISOString()}::timestamptz`,
          ),
        )
        .groupBy(approvalRequests.approverId, appUsers.fullName);

      res.json({
        windowDays: days,
        items: rows.map((r) => {
          const decided = Number(r.approved) + Number(r.rejected);
          return {
            approverId: r.approverId,
            approverName: r.fullName,
            totalCount: Number(r.total),
            approvedCount: Number(r.approved),
            rejectedCount: Number(r.rejected),
            pendingCount: Number(r.pending),
            avgResponseSeconds: Math.round(Number(r.avgResponseSeconds)),
            approvalRatePct: decided > 0 ? (Number(r.approved) / decided) * 100 : null,
            rejectionRatePct: decided > 0 ? (Number(r.rejected) / decided) * 100 : null,
          };
        }),
      });
    },
  );

  // -------------------------------------------------------------------
  // Time-entry anomaly highlighting (Phase 17 #26): flags timekeepers
  // whose daily hours over the last 90 days deviate >2.5 std-dev from
  // their own personal mean. Surfaces only the outlier days so a partner
  // can drill in without scanning hundreds of normal rows.
  // -------------------------------------------------------------------
  router.get(
    '/time-anomalies',
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
          entryDate: timeEntries.entryDate,
          hours: drz<string>`SUM(${timeEntries.hours})`,
        })
        .from(timeEntries)
        .innerJoin(engagements, eq(engagements.id, timeEntries.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(
            eq(clients.firmId, session.firmId),
            drz`${timeEntries.entryDate} >= ${since}::date`,
            drz`${timeEntries.status} <> 'ARCHIVED'`,
          ),
        )
        .groupBy(timeEntries.appUserId, timeEntries.entryDate);

      const byUser = new Map<string, Array<{ entryDate: string; hours: number }>>();
      for (const r of rows) {
        const arr = byUser.get(r.appUserId) ?? [];
        arr.push({ entryDate: r.entryDate, hours: Number(r.hours) });
        byUser.set(r.appUserId, arr);
      }
      const items: Array<{
        appUserId: string;
        entryDate: string;
        hours: number;
        mean: number;
        stdev: number;
        zScore: number;
      }> = [];
      for (const [appUserId, days] of byUser) {
        if (days.length < 5) continue;
        const mean = days.reduce((a, d) => a + d.hours, 0) / days.length;
        const variance = days.reduce((a, d) => a + (d.hours - mean) ** 2, 0) / days.length;
        const stdev = Math.sqrt(variance);
        if (stdev === 0) continue;
        for (const d of days) {
          const z = (d.hours - mean) / stdev;
          if (Math.abs(z) >= 2.5) {
            items.push({
              appUserId,
              entryDate: d.entryDate,
              hours: d.hours,
              mean: Number(mean.toFixed(2)),
              stdev: Number(stdev.toFixed(2)),
              zScore: Number(z.toFixed(2)),
            });
          }
        }
      }
      items.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
      res.json({ items: items.slice(0, 200) });
    },
  );

  // -------------------------------------------------------------------
  // Subscription profitability (Phase 17 #17). Per active recurring
  // plan: monthly revenue (from plan.amount_cents normalized to month),
  // estimated standard cost of in-scope hours logged in the trailing
  // 90 days, and rough gross margin pct. Helps the firm spot retainer
  // engagements where the bundle no longer fits.
  // -------------------------------------------------------------------
  router.get(
    '/subscription-profitability',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const trailingDays = Math.min(
        Math.max(parseInt(String(req.query['days'] ?? '90'), 10) || 90, 30),
        365,
      );
      const since = new Date(Date.now() - trailingDays * 86_400_000).toISOString().slice(0, 10);

      const plans = await deps.db
        .select({
          id: recurringBillingPlans.id,
          engagementId: recurringBillingPlans.engagementId,
          engagementName: engagements.name,
          clientName: clients.name,
          frequency: recurringBillingPlans.frequency,
          amountCents: recurringBillingPlans.amountCents,
        })
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(clients.firmId, session.firmId), eq(recurringBillingPlans.status, 'ACTIVE')));

      if (plans.length === 0) {
        res.json({ items: [] });
        return;
      }

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
          case 'SEMIANNUAL':
            return Math.round(amount / 6);
          case 'ANNUAL':
            return Math.round(amount / 12);
          default:
            // Unknown cadence: don't assume monthly (masked the missing
            // SEMIANNUAL case and overstated semiannual plans 6×).
            return 0;
        }
      };

      const engIds = plans.map((p) => p.engagementId);
      const usage = await deps.db
        .select({
          engagementId: timeEntries.engagementId,
          // Effective scope (schema rule) = inScopeFlag AND NOT
          // outOfScopeOverride. The user veto was previously ignored, so
          // vetoed entries were mis-counted as in-scope retainer cost.
          inScopeHours: drz<string>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} AND NOT ${timeEntries.outOfScopeOverride} THEN ${timeEntries.hours} ELSE 0 END), 0)`,
          inScopeCostCents: drz<number>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} AND NOT ${timeEntries.outOfScopeOverride} THEN ${timeEntries.standardAmountCents} ELSE 0 END), 0)`,
          oosHours: drz<string>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} AND NOT ${timeEntries.outOfScopeOverride} THEN 0 ELSE ${timeEntries.hours} END), 0)`,
          oosBilledCents: drz<number>`COALESCE(SUM(CASE WHEN ${timeEntries.inScopeFlag} AND NOT ${timeEntries.outOfScopeOverride} THEN 0 ELSE ${timeEntries.standardAmountCents} END), 0)`,
        })
        .from(timeEntries)
        .where(
          and(
            inArray(timeEntries.engagementId, engIds),
            // Exclude soft-deleted (ARCHIVED) entries.
            ne(timeEntries.status, 'ARCHIVED'),
            drz`${timeEntries.entryDate} >= ${since}::date`,
          ),
        )
        .groupBy(timeEntries.engagementId);
      const usageByEng = new Map(usage.map((u) => [u.engagementId, u]));

      const items = plans.map((p) => {
        const u = usageByEng.get(p.engagementId);
        const monthlyRevenue = monthly(p.frequency, Number(p.amountCents));
        const trailingRevenue = Math.round((monthlyRevenue * trailingDays) / 30);
        const inScopeCost = Number(u?.inScopeCostCents ?? 0);
        const oosBilled = Number(u?.oosBilledCents ?? 0);
        const totalRevenue = trailingRevenue + oosBilled;
        const totalCost = inScopeCost; // standard cost of in-scope work absorbed by retainer
        const grossMarginCents = totalRevenue - totalCost;
        const grossMarginPct = totalRevenue > 0 ? grossMarginCents / totalRevenue : null;
        return {
          planId: p.id,
          engagementId: p.engagementId,
          engagementName: p.engagementName,
          clientName: p.clientName,
          frequency: p.frequency,
          monthlyRevenue,
          trailingDays,
          trailingRevenue,
          inScopeHours: Number(u?.inScopeHours ?? 0),
          inScopeCostCents: inScopeCost,
          oosHours: Number(u?.oosHours ?? 0),
          oosBilledCents: oosBilled,
          grossMarginCents,
          grossMarginPct,
        };
      });
      items.sort((a, b) => (a.grossMarginPct ?? 0) - (b.grossMarginPct ?? 0));
      res.json({ items, windowDays: trailingDays });
    },
  );

  // -------------------------------------------------------------------
  // P6.1 — G.9 — Client-request billable capture rate. Of every
  // fulfilled client request, what fraction had a time entry linked at
  // fulfillment (or via an accepted suggestion)?
  // -------------------------------------------------------------------
  router.get(
    '/client-request-capture',
    requirePermission(deps, 'report:realization:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ measure: { fulfilledCount: 0, capturedCount: 0, captureRate: 0 } });
        return;
      }
      const QSchema = z.object({
        start: z.string().regex(DATE_RE).optional(),
        end: z.string().regex(DATE_RE).optional(),
      });
      const q = QSchema.safeParse(req.query);
      if (!q.success) {
        res.status(400).json({ error: 'invalid_query' });
        return;
      }
      const where = [eq(clientRequests.firmId, session.firmId)];
      if (q.data.start) where.push(drz`${clientRequests.fulfilledAt} >= ${q.data.start}::date`);
      if (q.data.end)
        where.push(drz`${clientRequests.fulfilledAt} < ${q.data.end}::date + interval '1 day'`);
      const rows = await deps.db
        .select({
          id: clientRequests.id,
          status: clientRequests.status,
          // True iff at least one time-entry link row exists for this
          // request that resolved to an accepted (= linked) suggestion
          // OR a direct time_entry_id binding.
          hasLink: drz<boolean>`
            EXISTS (
              SELECT 1
              FROM ${clientRequestTimeEntryLinks} l
              WHERE l.client_request_id = ${clientRequests.id}
                AND l.time_entry_id IS NOT NULL
                AND l.accepted_at IS NOT NULL
            )
          `,
        })
        .from(clientRequests)
        .where(and(...where));
      const measure = clientRequestBillableCaptureRate(
        rows.map((r) => ({
          fulfilled: r.status === 'FULFILLED',
          hasLinkedTimeEntry: Boolean(r.hasLink),
        })),
      );
      res.json({ measure, windowStart: q.data.start ?? null, windowEnd: q.data.end ?? null });
    },
  );

  // -------------------------------------------------------------------
  // Payments Received report.
  //
  // GET /api/staff/reports/payments-received
  //   ?from=YYYY-MM-DD       (default: first of current month)
  //   ?to=YYYY-MM-DD         (default: today)
  //   ?officeId=uuid         (optional — filter by the client's office)
  //   ?paymentMethod=string  (optional — case-insensitive match)
  //   ?sortBy=...&dir=...    (date | client | office | method | amount)
  //
  // Returns:
  //   - rows: per-receipt detail (date, client, office, method, ref, amount)
  //   - summary: { count, totalCents }
  //   - byMethod / byOffice: aggregated splits
  //   - methodOptions: distinct method values seen on the firm (for FE filter)
  //
  // Excludes status='PENDING' (those are unconfirmed intents). Includes
  // POSTED + every other terminal status so credit-apply receipts show.
  // Permission: payment:read.
  // -------------------------------------------------------------------
  router.get(
    '/payments-received',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({
          from: '',
          to: '',
          rows: [],
          summary: { count: 0, totalCents: 0 },
          byMethod: [],
          byOffice: [],
          methodOptions: [],
        });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = `${today.slice(0, 7)}-01`;
      const from =
        typeof req.query['from'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query['from'])
          ? req.query['from']
          : monthStart;
      const to =
        typeof req.query['to'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query['to'])
          ? req.query['to']
          : today;
      const officeId =
        typeof req.query['officeId'] === 'string' && req.query['officeId'].length > 0
          ? req.query['officeId']
          : null;
      const paymentMethod =
        typeof req.query['paymentMethod'] === 'string' &&
        req.query['paymentMethod'].trim().length > 0
          ? req.query['paymentMethod'].trim()
          : null;
      const sortBy = typeof req.query['sortBy'] === 'string' ? req.query['sortBy'] : 'date';
      const dir = req.query['dir'] === 'asc' ? 'asc' : 'desc';

      // Source-of-truth is the `payment` table. payment_receipt is a
      // convenience aggregation (subject + method + reference) created
      // when staff hits Payments → Receive; legacy / seed / webhook-
      // direct payments have no receipt. LEFT JOIN receipt so we still
      // catch the orphans. Date comes from receipt.payment_date when
      // present, otherwise payment.received_at.
      const reportRows = await deps.db.execute(drz`
        SELECT
          p.id::text                                                       AS id,
          COALESCE(pr.payment_date, (p.received_at AT TIME ZONE 'UTC')::date) AS payment_date,
          c.id::text                                                       AS client_id,
          c.name                                                           AS client_name,
          c.office_id::text                                                AS office_id,
          o.name                                                           AS office_name,
          COALESCE(pr.payment_method, p.provider)                          AS payment_method,
          p.provider                                                       AS provider,
          COALESCE(pr.mode, 'RECORD')                                      AS mode,
          pr.reference                                                     AS reference,
          (p.amount_cents - COALESCE(p.refunded_amount_cents, 0))          AS total_cents,
          p.status::text                                                   AS status
        FROM vibetb.payment p
        INNER JOIN vibetb.invoice  i ON i.id = p.invoice_id
        INNER JOIN vibetb.client   c ON c.id = i.client_id
        LEFT  JOIN vibetb.office   o ON o.id = c.office_id
        LEFT  JOIN vibetb.payment_receipt pr ON pr.id = p.receipt_id
        WHERE c.firm_id = ${session.firmId}
          -- Net money received: SUCCEEDED plus PARTIALLY_REFUNDED (a partial
          -- refund still leaves net cash received). Voided payments excluded.
          AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED')
          AND p.voided_at IS NULL
          AND COALESCE(pr.payment_date, (p.received_at AT TIME ZONE 'UTC')::date)
              BETWEEN ${from} AND ${to}
          ${officeId ? drz`AND c.office_id = ${officeId}` : drz``}
          ${paymentMethod ? drz`AND COALESCE(pr.payment_method, p.provider) ILIKE ${paymentMethod}` : drz``}
        ORDER BY
          CASE WHEN ${sortBy} = 'client'  AND ${dir} = 'asc'  THEN c.name END ASC,
          CASE WHEN ${sortBy} = 'client'  AND ${dir} = 'desc' THEN c.name END DESC,
          CASE WHEN ${sortBy} = 'office'  AND ${dir} = 'asc'  THEN o.name END ASC,
          CASE WHEN ${sortBy} = 'office'  AND ${dir} = 'desc' THEN o.name END DESC,
          CASE WHEN ${sortBy} = 'method'  AND ${dir} = 'asc'  THEN COALESCE(pr.payment_method, p.provider) END ASC,
          CASE WHEN ${sortBy} = 'method'  AND ${dir} = 'desc' THEN COALESCE(pr.payment_method, p.provider) END DESC,
          CASE WHEN ${sortBy} = 'amount'  AND ${dir} = 'asc'  THEN (p.amount_cents - COALESCE(p.refunded_amount_cents, 0)) END ASC,
          CASE WHEN ${sortBy} = 'amount'  AND ${dir} = 'desc' THEN (p.amount_cents - COALESCE(p.refunded_amount_cents, 0)) END DESC,
          CASE WHEN ${sortBy} = 'date'    AND ${dir} = 'asc'
               THEN COALESCE(pr.payment_date, (p.received_at AT TIME ZONE 'UTC')::date) END ASC,
          COALESCE(pr.payment_date, (p.received_at AT TIME ZONE 'UTC')::date) DESC
        LIMIT 2000
      `);
      const rawRows =
        (
          reportRows as unknown as {
            rows: Array<{
              id: string;
              payment_date: string | Date;
              client_id: string;
              client_name: string;
              office_id: string | null;
              office_name: string | null;
              payment_method: string;
              provider: string;
              mode: string;
              reference: string | null;
              total_cents: string | number;
              status: string;
            }>;
          }
        ).rows ?? (reportRows as unknown as never[]);
      const rows = (Array.isArray(rawRows) ? rawRows : []).map((r) => ({
        id: r.id,
        paymentDate:
          typeof r.payment_date === 'string'
            ? r.payment_date
            : new Date(r.payment_date as unknown as Date).toISOString().slice(0, 10),
        clientId: r.client_id,
        clientName: r.client_name,
        officeId: r.office_id,
        officeName: r.office_name,
        paymentMethod: r.payment_method ?? '—',
        provider: r.provider,
        mode: r.mode,
        reference: r.reference,
        totalCents: Number(r.total_cents),
        status: r.status,
      }));

      const summary = rows.reduce(
        (acc, r) => ({ count: acc.count + 1, totalCents: acc.totalCents + r.totalCents }),
        { count: 0, totalCents: 0 },
      );
      const byMethodMap = new Map<string, { count: number; totalCents: number }>();
      const byOfficeMap = new Map<string, { name: string; count: number; totalCents: number }>();
      for (const r of rows) {
        const m = byMethodMap.get(r.paymentMethod) ?? { count: 0, totalCents: 0 };
        m.count += 1;
        m.totalCents += r.totalCents;
        byMethodMap.set(r.paymentMethod, m);
        const oKey = r.officeId ?? 'none';
        const o = byOfficeMap.get(oKey) ?? {
          name: r.officeName ?? '— no office —',
          count: 0,
          totalCents: 0,
        };
        o.count += 1;
        o.totalCents += r.totalCents;
        byOfficeMap.set(oKey, o);
      }

      // Distinct method values seen in the firm — drives the FE filter
      // dropdown. Pulls from both receipt.payment_method (when present)
      // and payment.provider (for orphan rows) so the dropdown reflects
      // what the user actually sees in the table.
      const methodOpts = await deps.db.execute(drz`
        SELECT DISTINCT method FROM (
          SELECT pr.payment_method AS method
          FROM vibetb.payment_receipt pr
          WHERE pr.firm_id = ${session.firmId}
            AND pr.payment_method IS NOT NULL
          UNION
          SELECT p.provider AS method
          FROM vibetb.payment p
          INNER JOIN vibetb.invoice i ON i.id = p.invoice_id
          INNER JOIN vibetb.client  c ON c.id = i.client_id
          WHERE c.firm_id = ${session.firmId}
            AND p.receipt_id IS NULL
        ) u
        WHERE method IS NOT NULL
        ORDER BY method
      `);
      const methodOptions = (
        ((methodOpts as unknown as { rows: Array<{ method: string }> }).rows ??
          (methodOpts as unknown as Array<{ method: string }>)) as Array<{ method: string }>
      )
        .map((r) => r.method)
        .filter(Boolean);

      res.json({
        from,
        to,
        rows,
        summary,
        byMethod: Array.from(byMethodMap.entries()).map(([method, v]) => ({
          method,
          count: v.count,
          totalCents: v.totalCents,
        })),
        byOffice: Array.from(byOfficeMap.entries()).map(([oid, v]) => ({
          officeId: oid === 'none' ? null : oid,
          name: v.name,
          count: v.count,
          totalCents: v.totalCents,
        })),
        methodOptions,
      });
    },
  );

  return router;
}
