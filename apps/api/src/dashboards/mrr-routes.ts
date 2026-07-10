// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P29 — MRR + cash flow + renewals dashboard.
//
// GET /api/staff/dashboards/mrr
//
// Loads:
//   • recurring_billing_plan rows for ACTIVE engagements
//   • plans whose engagement.created_at is in the current month
//   • plans whose engagement.closed_at is in the prior month
//   • invoices (firm-scoped) with status / due_date
//   • payment_mandates state counts
//   • renewals rows with state=CANDIDATE
//   • on-completion pipeline: sum of total_one_time_cents on
//     proposals in {SENT, VIEWED, IN_PROGRESS}
//
// All math lives in @vibe/core/proposals (mrr-rollup).

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  engagements,
  invoices,
  paymentMandates,
  proposals,
  recurringBillingPlans,
  renewals,
  serviceLines,
  engagementTypes,
} from '@vibe/db/schema';
import {
  computeMrrRollup,
  type InvoiceForCashFlow,
  type MandateCounts,
  type PlanForMrr,
  type RecurringFrequency,
  type RenewalRowForDashboard,
} from '@vibe/core/proposals';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';

export interface MrrDashboardDeps extends RbacDeps {
  db: Database | null;
}

function startOfMonth(d: Date): Date {
  const c = new Date(d);
  c.setUTCDate(1);
  c.setUTCHours(0, 0, 0, 0);
  return c;
}
function startOfPriorMonth(d: Date): Date {
  const c = startOfMonth(d);
  c.setUTCMonth(c.getUTCMonth() - 1);
  return c;
}

export function createMrrDashboardRouter(deps: MrrDashboardDeps): Router {
  const router = express.Router();

  router.get(
    '/mrr',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const now = new Date();
      const monthStart = startOfMonth(now);
      const priorMonthStart = startOfPriorMonth(now);

      // 1) All firm engagements (active or closed) — needed to scope
      //    recurring plan rows + categorize them.
      const engRows = await deps.db
        .select({
          id: engagements.id,
          clientId: engagements.clientId,
          engagementTypeId: engagements.engagementTypeId,
          status: engagements.status,
          closedAt: engagements.closedAt,
          createdAt: engagements.createdAt,
          firmId: clients.firmId,
        })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(clients.firmId, session.firmId));

      const engById = new Map(engRows.map((e) => [e.id, e]));
      const activeEngIds = engRows.filter((e) => e.status === 'ACTIVE').map((e) => e.id);
      const closedLastMonthIds = engRows
        .filter((e) => e.closedAt && e.closedAt >= priorMonthStart && e.closedAt < monthStart)
        .map((e) => e.id);

      // 2) Resolve engagement type → service category for MRR-by-category.
      const typeIds = Array.from(
        new Set(engRows.flatMap((e) => (e.engagementTypeId ? [e.engagementTypeId] : []))),
      );
      const categoryByEng = new Map<string, string>();
      if (typeIds.length > 0) {
        const typeRows = await deps.db
          .select({
            id: engagementTypes.id,
            name: engagementTypes.name,
            serviceLineName: serviceLines.name,
          })
          .from(engagementTypes)
          .leftJoin(serviceLines, eq(serviceLines.id, engagementTypes.serviceLineId))
          .where(inArray(engagementTypes.id, typeIds));
        const byTypeId = new Map(
          typeRows.map((t) => [t.id, t.serviceLineName ?? t.name ?? '(uncategorized)']),
        );
        for (const e of engRows) {
          if (e.engagementTypeId) {
            const cat = byTypeId.get(e.engagementTypeId);
            if (cat) categoryByEng.set(e.id, cat);
          }
        }
      }

      // 3) Recurring billing plans.
      let activePlans: PlanForMrr[] = [];
      let newPlansThisMonth: PlanForMrr[] = [];
      let churnedPlansLastMonth: PlanForMrr[] = [];
      if (activeEngIds.length > 0) {
        const planRows = await deps.db
          .select({
            engagementId: recurringBillingPlans.engagementId,
            amountCents: recurringBillingPlans.amountCents,
            frequency: recurringBillingPlans.frequency,
            createdAt: recurringBillingPlans.createdAt,
            status: recurringBillingPlans.status,
          })
          .from(recurringBillingPlans)
          .where(
            and(
              inArray(recurringBillingPlans.engagementId, activeEngIds),
              eq(recurringBillingPlans.status, 'ACTIVE'),
            ),
          );
        activePlans = planRows.map((p) => ({
          engagementId: p.engagementId,
          amountCents: p.amountCents,
          frequency: p.frequency as RecurringFrequency,
          category: categoryByEng.get(p.engagementId) ?? null,
        }));
        newPlansThisMonth = planRows
          .filter((p) => p.createdAt >= monthStart)
          .map((p) => ({
            engagementId: p.engagementId,
            amountCents: p.amountCents,
            frequency: p.frequency as RecurringFrequency,
            category: categoryByEng.get(p.engagementId) ?? null,
          }));
      }
      if (closedLastMonthIds.length > 0) {
        const churnedRows = await deps.db
          .select({
            engagementId: recurringBillingPlans.engagementId,
            amountCents: recurringBillingPlans.amountCents,
            frequency: recurringBillingPlans.frequency,
          })
          .from(recurringBillingPlans)
          .where(inArray(recurringBillingPlans.engagementId, closedLastMonthIds));
        churnedPlansLastMonth = churnedRows.map((p) => ({
          engagementId: p.engagementId,
          amountCents: p.amountCents,
          frequency: p.frequency as RecurringFrequency,
          category: categoryByEng.get(p.engagementId) ?? null,
        }));
      }

      // 4) Invoices.
      const invoiceRows = await deps.db
        .select({
          id: invoices.id,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          dueDate: invoices.dueDate,
          status: invoices.status,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId));
      const invoiceData: InvoiceForCashFlow[] = invoiceRows.map((r) => ({
        id: r.id,
        totalCents: r.totalCents,
        paidCents: r.paidCents,
        dueDate: r.dueDate,
        status: r.status as InvoiceForCashFlow['status'],
      }));

      // 5) Mandate counts.
      const mandateRows = await deps.db
        .select({
          state: paymentMandates.state,
          count: sql<string>`COUNT(*)::text`,
        })
        .from(paymentMandates)
        .where(eq(paymentMandates.firmId, session.firmId))
        .groupBy(paymentMandates.state);
      const mandateCounts: MandateCounts = {
        pendingVerification: 0,
        active: 0,
        invalid: 0,
        revoked: 0,
      };
      for (const m of mandateRows) {
        const c = Number(m.count) || 0;
        if (m.state === 'PENDING_VERIFICATION') mandateCounts.pendingVerification = c;
        else if (m.state === 'ACTIVE') mandateCounts.active = c;
        else if (m.state === 'INVALID') mandateCounts.invalid = c;
        else if (m.state === 'REVOKED') mandateCounts.revoked = c;
      }

      // 6) Renewal candidates. currentTotalCents is taken from the
      //    engagement's fee_amount_cents (renewals table doesn't carry
      //    a snapshot — it carries uplift + suggested).
      const renewalRows = await deps.db
        .select({
          id: renewals.id,
          engagementId: renewals.currentEngagementId,
          endDate: engagements.endDate,
          feeAmountCents: engagements.feeAmountCents,
          suggestedTotalCents: renewals.suggestedTotalCents,
          upliftBps: renewals.upliftBps,
          state: renewals.state,
        })
        .from(renewals)
        .innerJoin(engagements, eq(engagements.id, renewals.currentEngagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(clients.firmId, session.firmId));
      const renewalData: RenewalRowForDashboard[] = renewalRows
        .filter((r) => r.endDate != null)
        .map((r) => ({
          id: r.id,
          engagementId: r.engagementId,
          endDate: r.endDate!,
          currentTotalCents: Number(r.feeAmountCents ?? 0),
          suggestedTotalCents: r.suggestedTotalCents == null ? null : Number(r.suggestedTotalCents),
          upliftBps: r.upliftBps,
          state: r.state as RenewalRowForDashboard['state'],
        }));

      // 7) On-completion pipeline. Sum total_one_time_cents on SENT /
      //    VIEWED / IN_PROGRESS proposals.
      const pipelineSum = await deps.db
        .select({
          total: sql<string>`COALESCE(SUM(${proposals.totalOneTimeCents}), 0)::text`,
        })
        .from(proposals)
        .where(
          and(
            eq(proposals.firmId, session.firmId),
            inArray(proposals.status, ['SENT', 'VIEWED', 'IN_PROGRESS']),
          ),
        );
      const onCompletionPipelineCents = Number(pipelineSum[0]?.total ?? '0') || 0;

      // 8) Prior-month MRR: v1 returns null. A future snapshot table
      //    will populate this. We hide the field gracefully in the UI.
      const priorMonthMrrCents: number | null = null;

      const result = computeMrrRollup({
        now: now.toISOString(),
        activePlans,
        newPlansThisMonth,
        churnedPlansLastMonth,
        priorMonthMrrCents,
        invoices: invoiceData,
        mandates: mandateCounts,
        renewals: renewalData,
        onCompletionPipelineCents,
      });
      // touch unused-import lint silencers; lt + engById reserved for
      // future drill-down endpoints.
      void lt;
      void engById;
      void gte;
      res.json(result);
    },
  );

  return router;
}
