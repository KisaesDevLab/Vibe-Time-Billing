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
  recurringBillingPlans,
  recurringBillingPlanServices,
  serviceLines,
} from '@vibe/db/schema';

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
