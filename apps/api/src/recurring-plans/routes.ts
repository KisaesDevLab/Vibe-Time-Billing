// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Recurring-billing plan administration (Phase 10). Lists active plans for
// the firm, exposes pause/resume/archive actions, and a summary "health"
// endpoint for the admin dashboard.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  engagements,
  invoiceLineItems,
  invoices,
  recurringBillingPlans,
  recurringBillingPlanServices,
  serviceLines,
} from '@vibe/db/schema';
import { desc as drzDesc } from 'drizzle-orm';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface RecurringPlanRoutesDeps extends RbacDeps {
  db: Database | null;
}

const PauseSchema = z.object({ reason: z.string().min(1).max(400) });

const CreateSchema = z.object({
  engagementId: z.string().uuid(),
  frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']),
  amountCents: z.number().int().positive(),
  billingDayOfMonth: z.number().int().min(1).max(31).optional(),
  nextRunDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  autoPayFlag: z.boolean().optional(),
  autoPayPaymentMethodId: z.string().uuid().optional(),
});

export function createRecurringPlanRouter(deps: RecurringPlanRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds = [eq(clients.firmId, session.firmId)];
      const engId =
        typeof req.query['engagementId'] === 'string' ? req.query['engagementId'] : null;
      if (engId) conds.push(eq(recurringBillingPlans.engagementId, engId));
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      if (status === 'ACTIVE' || status === 'PAUSED' || status === 'CANCELLED') {
        conds.push(eq(recurringBillingPlans.status, status));
      }
      const items = await deps.db
        .select({
          id: recurringBillingPlans.id,
          engagementId: recurringBillingPlans.engagementId,
          engagementName: engagements.name,
          clientId: engagements.clientId,
          clientName: clients.name,
          frequency: recurringBillingPlans.frequency,
          amountCents: recurringBillingPlans.amountCents,
          nextRunDate: recurringBillingPlans.nextRunDate,
          status: recurringBillingPlans.status,
          autoPayFlag: recurringBillingPlans.autoPayFlag,
          pausedAt: recurringBillingPlans.pausedAt,
          pausedReason: recurringBillingPlans.pausedReason,
          consecutiveFailureCount: recurringBillingPlans.consecutiveFailureCount,
          autopayPauseThreshold: recurringBillingPlans.autopayPauseThreshold,
        })
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(...conds))
        .orderBy(desc(recurringBillingPlans.nextRunDate))
        .limit(500);
      res.json({ items });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      // Scope: engagement must belong to firm.
      const [scope] = await deps.db
        .select({ id: engagements.id })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(engagements.id, parsed.data.engagementId), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [row] = await deps.db
        .insert(recurringBillingPlans)
        .values({
          engagementId: parsed.data.engagementId,
          frequency: parsed.data.frequency,
          amountCents: parsed.data.amountCents,
          billingDayOfMonth: parsed.data.billingDayOfMonth ?? null,
          nextRunDate: parsed.data.nextRunDate,
          autoPayFlag: parsed.data.autoPayFlag ?? false,
          autoPayPaymentMethodId: parsed.data.autoPayPaymentMethodId ?? null,
        })
        .returning({ id: recurringBillingPlans.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'recurring_billing_plan',
        entityId: row?.id,
        actorAppUserId: session.appUserId,
        after: {
          engagementId: parsed.data.engagementId,
          frequency: parsed.data.frequency,
          amountCents: parsed.data.amountCents,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/health',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ counts: { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 }, dueSoon: 0 });
        return;
      }
      const rows = await deps.db
        .select({
          status: recurringBillingPlans.status,
          c: sql<number>`COUNT(*)`.as('c'),
        })
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(eq(clients.firmId, session.firmId))
        .groupBy(recurringBillingPlans.status);
      const counts = { ACTIVE: 0, PAUSED: 0, CANCELLED: 0 } as Record<string, number>;
      for (const r of rows) counts[r.status] = Number(r.c);
      const [dueSoon] = await deps.db
        .select({ c: sql<number>`COUNT(*)`.as('c') })
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(
            eq(clients.firmId, session.firmId),
            eq(recurringBillingPlans.status, 'ACTIVE'),
            sql`${recurringBillingPlans.nextRunDate} <= CURRENT_DATE + INTERVAL '7 days'`,
          ),
        );
      res.json({ counts, dueSoonWithin7Days: Number(dueSoon?.c ?? 0) });
    },
  );

  router.get(
    '/:id',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ plan: null });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(recurringBillingPlans.id, req.params['id']!), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({
        plan: row.recurring_billing_plan,
        engagement: row.engagement,
        client: row.client,
      });
    },
  );

  router.get(
    '/:id/services',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select({
          planId: recurringBillingPlanServices.planId,
          serviceLineId: recurringBillingPlanServices.serviceLineId,
          serviceLineName: serviceLines.name,
          includedHours: recurringBillingPlanServices.includedHours,
        })
        .from(recurringBillingPlanServices)
        .innerJoin(serviceLines, eq(serviceLines.id, recurringBillingPlanServices.serviceLineId))
        .where(eq(recurringBillingPlanServices.planId, plan.id));
      res.json({ items });
    },
  );

  router.post(
    '/:id/services',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = req.body as { serviceLineId?: unknown; includedHours?: unknown };
      const serviceLineId = typeof body.serviceLineId === 'string' ? body.serviceLineId : null;
      if (!serviceLineId) {
        res.status(400).json({ error: 'service_line_id_required' });
        return;
      }
      const includedHours = typeof body.includedHours === 'number' ? body.includedHours : null;
      await deps.db
        .insert(recurringBillingPlanServices)
        .values({
          planId: plan.id,
          serviceLineId,
          includedHours: includedHours != null ? includedHours.toString() : null,
        })
        .onConflictDoNothing();
      res.status(201).json({ ok: true });
    },
  );

  router.patch(
    '/:id/services/:serviceLineId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const includedHours =
        typeof req.body?.includedHours === 'number' ? req.body.includedHours : null;
      await deps.db
        .update(recurringBillingPlanServices)
        .set({ includedHours: includedHours != null ? includedHours.toString() : null })
        .where(
          and(
            eq(recurringBillingPlanServices.planId, plan.id),
            eq(recurringBillingPlanServices.serviceLineId, req.params['serviceLineId']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.delete(
    '/:id/services/:serviceLineId',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await deps.db
        .delete(recurringBillingPlanServices)
        .where(
          and(
            eq(recurringBillingPlanServices.planId, plan.id),
            eq(recurringBillingPlanServices.serviceLineId, req.params['serviceLineId']!),
          ),
        );
      res.json({ ok: true });
    },
  );

  router.get(
    '/due-now',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const items = await deps.db
        .select({
          id: recurringBillingPlans.id,
          engagementId: recurringBillingPlans.engagementId,
          engagementName: engagements.name,
          clientName: clients.name,
          amountCents: recurringBillingPlans.amountCents,
          nextRunDate: recurringBillingPlans.nextRunDate,
        })
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(
            eq(clients.firmId, session.firmId),
            eq(recurringBillingPlans.status, 'ACTIVE'),
            sql`${recurringBillingPlans.nextRunDate} <= ${today}::date`,
          ),
        )
        .orderBy(recurringBillingPlans.nextRunDate);
      res.json({ items });
    },
  );

  router.post(
    '/:id/recalc-next-run',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [src] = await deps.db
        .select()
        .from(recurringBillingPlans)
        .where(eq(recurringBillingPlans.id, plan.id))
        .limit(1);
      if (!src) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const { nextRunDate } = await import('@vibe/core/billing');
      const nrd = nextRunDate(src.nextRunDate, src.frequency);
      await deps.db
        .update(recurringBillingPlans)
        .set({ nextRunDate: nrd })
        .where(eq(recurringBillingPlans.id, plan.id));
      res.json({ ok: true, nextRunDate: nrd });
    },
  );

  router.post(
    '/:id/duplicate',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [src] = await deps.db
        .select()
        .from(recurringBillingPlans)
        .where(eq(recurringBillingPlans.id, plan.id))
        .limit(1);
      if (!src) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const {
        id: _id,
        createdAt: _ca,
        pausedAt: _pa,
        pausedReason: _pr,
        ...clonable
      } = src as typeof src & { id: string };
      void _id;
      void _ca;
      void _pa;
      void _pr;
      const [row] = await deps.db
        .insert(recurringBillingPlans)
        .values({ ...(clonable as typeof src), status: 'ACTIVE' })
        .returning({ id: recurringBillingPlans.id });
      res.status(201).json({ id: row?.id });
    },
  );

  router.get(
    '/:id/invoices',
    requirePermission(deps, 'invoice:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Find invoices that have a RECURRING_FEE line item sourced from this plan.
      const rows = await deps.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          issueDate: invoices.issueDate,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          status: invoices.status,
        })
        .from(invoices)
        .innerJoin(invoiceLineItems, eq(invoiceLineItems.invoiceId, invoices.id))
        .where(
          and(
            eq(invoiceLineItems.sourceRefType, 'recurring_plan'),
            eq(invoiceLineItems.sourceRefId, plan.id),
          ),
        )
        .orderBy(drzDesc(invoices.issueDate));
      res.json({ items: rows });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const body = req.body as {
        amountCents?: unknown;
        frequency?: unknown;
        nextRunDate?: unknown;
        autoPayFlag?: unknown;
        autoPayPaymentMethodId?: unknown;
      };
      const patch: Record<string, unknown> = {};
      if (typeof body.amountCents === 'number' && body.amountCents > 0) {
        patch['amountCents'] = body.amountCents;
      }
      if (
        typeof body.frequency === 'string' &&
        ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'].includes(
          body.frequency,
        )
      ) {
        patch['frequency'] = body.frequency;
      }
      if (typeof body.nextRunDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.nextRunDate)) {
        patch['nextRunDate'] = body.nextRunDate;
      }
      if (typeof body.autoPayFlag === 'boolean') patch['autoPayFlag'] = body.autoPayFlag;
      if (typeof body.autoPayPaymentMethodId === 'string') {
        patch['autoPayPaymentMethodId'] = body.autoPayPaymentMethodId;
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: 'no_fields_to_update' });
        return;
      }
      await deps.db
        .update(recurringBillingPlans)
        .set(patch)
        .where(eq(recurringBillingPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'recurring_billing_plan',
        entityId: plan.id,
        actorAppUserId: session.appUserId,
        after: patch,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/run-now',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Setting next_run_date to today pulls it into the next worker tick.
      const today = new Date().toISOString().slice(0, 10);
      await deps.db
        .update(recurringBillingPlans)
        .set({ nextRunDate: today })
        .where(eq(recurringBillingPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'recurring_billing_plan',
        entityId: plan.id,
        actorAppUserId: session.appUserId,
        after: { runNow: true, nextRunDate: today },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/pause',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = PauseSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.status !== 'ACTIVE') {
        res.status(409).json({ error: 'plan_not_active', status: plan.status });
        return;
      }
      await deps.db
        .update(recurringBillingPlans)
        .set({ status: 'PAUSED', pausedAt: new Date(), pausedReason: parsed.data.reason })
        .where(eq(recurringBillingPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'recurring_billing_plan',
        entityId: plan.id,
        actorAppUserId: session.appUserId,
        after: { status: 'PAUSED', reason: parsed.data.reason },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/resume',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.status !== 'PAUSED') {
        res.status(409).json({ error: 'plan_not_paused', status: plan.status });
        return;
      }
      await deps.db
        .update(recurringBillingPlans)
        .set({ status: 'ACTIVE', pausedAt: null, pausedReason: null })
        .where(eq(recurringBillingPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'recurring_billing_plan',
        entityId: plan.id,
        actorAppUserId: session.appUserId,
        after: { status: 'ACTIVE' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/cancel',
    requirePermission(deps, 'engagement:archive'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const plan = await planForFirm(deps.db, session.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.status === 'CANCELLED') {
        res.status(409).json({ error: 'already_cancelled' });
        return;
      }
      await deps.db
        .update(recurringBillingPlans)
        .set({ status: 'CANCELLED' })
        .where(eq(recurringBillingPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'ARCHIVE',
        entityType: 'recurring_billing_plan',
        entityId: plan.id,
        actorAppUserId: session.appUserId,
        after: { status: 'CANCELLED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // -----------------------------------------------------------------
  // Plan-change proration helper (Phase 10 #22). Given a plan and a
  // target new amount + change date, compute the prorated credit/debit
  // for the current billing period. Does NOT write — caller applies
  // via /:id with PATCH + a credit-memo line item.
  // -----------------------------------------------------------------
  router.post(
    '/:id/proration-preview',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, prorationCents: 0 });
        return;
      }
      const body = req.body as { newAmountCents?: unknown; changeDate?: unknown };
      const newAmount = typeof body.newAmountCents === 'number' ? body.newAmountCents : NaN;
      const changeDate =
        typeof body.changeDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.changeDate)
          ? body.changeDate
          : null;
      if (!Number.isFinite(newAmount) || !changeDate) {
        res.status(400).json({ error: 'newAmountCents_and_changeDate_required' });
        return;
      }
      const [plan] = await deps.db
        .select()
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(recurringBillingPlans.id, req.params['id']!), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const oldAmount = Number(plan.recurring_billing_plan.amountCents);
      // Period length per frequency.
      const periodDays =
        plan.recurring_billing_plan.frequency === 'MONTHLY'
          ? 30
          : plan.recurring_billing_plan.frequency === 'QUARTERLY'
            ? 91
            : plan.recurring_billing_plan.frequency === 'ANNUAL'
              ? 365
              : plan.recurring_billing_plan.frequency === 'BIWEEKLY'
                ? 14
                : 7;
      const change = new Date(changeDate);
      const nextRun = new Date(plan.recurring_billing_plan.nextRunDate);
      // Days into current period assumed = periodDays - daysRemaining.
      const daysRemaining = Math.max(
        0,
        Math.floor((nextRun.getTime() - change.getTime()) / 86_400_000),
      );
      const daysUsed = Math.max(0, periodDays - daysRemaining);
      // Credit for un-used portion of old + debit for un-used portion of new.
      const oldUnused = Math.round((oldAmount * daysRemaining) / periodDays);
      const newUnused = Math.round((newAmount * daysRemaining) / periodDays);
      const prorationCents = newUnused - oldUnused;
      res.json({
        oldAmountCents: oldAmount,
        newAmountCents: newAmount,
        changeDate,
        nextRunDate: plan.recurring_billing_plan.nextRunDate,
        periodDays,
        daysUsed,
        daysRemaining,
        prorationCents,
        prorationDescription:
          prorationCents >= 0
            ? `Charge $${(prorationCents / 100).toFixed(2)} for plan upgrade (${daysRemaining} of ${periodDays} days remaining)`
            : `Credit $${(Math.abs(prorationCents) / 100).toFixed(2)} for plan downgrade (${daysRemaining} of ${periodDays} days remaining)`,
      });
    },
  );

  // Phase 10 #21 — proration commit. POST /:id/proration-commit applies
  // the plan amount change in one transaction: updates
  // recurring_billing_plan.amount_cents and inserts a one-off DRAFT
  // invoice carrying the proration line (or a credit memo when the
  // proration is negative). Caller previews via /proration-preview
  // before posting.
  router.post(
    '/:id/proration-commit',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const body = req.body as { newAmountCents?: unknown; changeDate?: unknown };
      const newAmount = typeof body.newAmountCents === 'number' ? body.newAmountCents : NaN;
      const changeDate =
        typeof body.changeDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.changeDate)
          ? body.changeDate
          : null;
      if (!Number.isFinite(newAmount) || newAmount < 0 || !changeDate) {
        res.status(400).json({ error: 'newAmountCents_and_changeDate_required' });
        return;
      }
      const [plan] = await deps.db
        .select()
        .from(recurringBillingPlans)
        .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(
          and(eq(recurringBillingPlans.id, req.params['id']!), eq(clients.firmId, session.firmId)),
        )
        .limit(1);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const oldAmount = Number(plan.recurring_billing_plan.amountCents);
      const periodDays =
        plan.recurring_billing_plan.frequency === 'MONTHLY'
          ? 30
          : plan.recurring_billing_plan.frequency === 'QUARTERLY'
            ? 91
            : plan.recurring_billing_plan.frequency === 'ANNUAL'
              ? 365
              : plan.recurring_billing_plan.frequency === 'BIWEEKLY'
                ? 14
                : 7;
      const change = new Date(changeDate);
      const nextRun = new Date(plan.recurring_billing_plan.nextRunDate);
      const daysRemaining = Math.max(
        0,
        Math.floor((nextRun.getTime() - change.getTime()) / 86_400_000),
      );
      const oldUnused = Math.round((oldAmount * daysRemaining) / periodDays);
      const newUnused = Math.round((newAmount * daysRemaining) / periodDays);
      const prorationCents = newUnused - oldUnused;

      const result = await deps.db.transaction(async (tx) => {
        await tx
          .update(recurringBillingPlans)
          .set({ amountCents: newAmount })
          .where(eq(recurringBillingPlans.id, plan.recurring_billing_plan.id));

        // Skip the proration invoice when delta is zero (re-apply or no-op).
        if (prorationCents === 0)
          return { planId: plan.recurring_billing_plan.id, invoiceId: null };

        // Build a small DRAFT invoice carrying the proration.
        const [maxNum] = await tx
          .select({
            n: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
          })
          .from(invoices)
          .where(eq(invoices.firmId, session.firmId));
        const seq = Number(maxNum?.n ?? 0) + 1;
        const today = new Date().toISOString().slice(0, 10);
        const number = `PR-${today.slice(0, 4)}-${String(seq).padStart(5, '0')}`;
        const [inv] = await tx
          .insert(invoices)
          .values({
            firmId: session.firmId,
            clientId: plan.client.id,
            primaryEngagementId: plan.recurring_billing_plan.engagementId,
            invoiceNumber: number,
            issueDate: today,
            dueDate: today,
            subtotalCents: prorationCents,
            feeCents: 0,
            totalCents: prorationCents,
            status: 'DRAFT',
            notes: `Proration on plan change: $${(oldAmount / 100).toFixed(2)} → $${(newAmount / 100).toFixed(2)} effective ${changeDate}`,
          })
          .returning({ id: invoices.id });
        if (!inv) throw new Error('proration_invoice_failed');
        await tx.insert(invoiceLineItems).values({
          invoiceId: inv.id,
          kind: 'CUSTOM',
          description:
            prorationCents >= 0
              ? `Plan upgrade proration (${daysRemaining} of ${periodDays} days)`
              : `Plan downgrade credit (${daysRemaining} of ${periodDays} days)`,
          amountCents: prorationCents,
          sourceRefType: 'recurring_billing_plan',
          sourceRefId: plan.recurring_billing_plan.id,
          sortOrder: 0,
        });
        return { planId: plan.recurring_billing_plan.id, invoiceId: inv.id };
      });

      res.json({
        ok: true,
        planId: result.planId,
        invoiceId: result.invoiceId,
        prorationCents,
        oldAmountCents: oldAmount,
        newAmountCents: newAmount,
      });
    },
  );

  return router;
}

async function planForFirm(
  db: Database,
  firmId: string,
  planId: string,
): Promise<{ id: string; status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' } | null> {
  const [row] = await db
    .select({ id: recurringBillingPlans.id, status: recurringBillingPlans.status })
    .from(recurringBillingPlans)
    .innerJoin(engagements, eq(engagements.id, recurringBillingPlans.engagementId))
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(and(eq(recurringBillingPlans.id, planId), eq(clients.firmId, firmId)))
    .limit(1);
  return row ?? null;
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

// inArray imported but used in future filter; suppress unused warning:
void inArray;
