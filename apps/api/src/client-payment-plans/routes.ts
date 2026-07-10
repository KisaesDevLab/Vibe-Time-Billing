// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff API for recurring installment payment plans (0192). A plan charges a
// client's saved method a fixed installment each cycle, applied oldest-first
// across the client's open invoices, until the balance clears. The daily
// `payment-plan-charge` worker does the scheduled charging; this router is the
// staff control surface: list / create / update / pause / resume / cancel and
// an immediate "run now". Mounted at /api/staff/client-payment-plans.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clientPaymentPlans, paymentMethod } from '@vibe/db/schema';
import { nextRunDate } from '@vibe/core/billing';

import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getBlockedClientIdsCached } from '../clients/access';
import { emitAudit } from '../auth/audit';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { chargeClientBalanceOffSession } from '../payments/off-session-charge';
import {
  buildAllocations,
  loadOpenInvoicesOldestFirst,
  outstandingCents,
} from '../payments/plan-allocation';

export interface ClientPaymentPlansDeps extends RbacDeps {
  db: Database | null;
}

const FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  paymentMethodId: z.string().uuid(),
  frequency: z.enum(FREQUENCIES),
  installmentCents: z.number().int().positive(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  authorizationNote: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
});

const UpdateSchema = z.object({
  frequency: z.enum(FREQUENCIES).optional(),
  installmentCents: z.number().int().positive().optional(),
  nextRunDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: z.string().max(2000).optional(),
});

const PauseSchema = z.object({ reason: z.string().max(400).optional() });

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function clientBlocked(
  deps: ClientPaymentPlansDeps,
  req: Request,
  clientId: string,
): Promise<boolean> {
  const s = req.staffSession!;
  const blocked = await getBlockedClientIdsCached(deps, req, s.appUserId, s.firmId);
  return blocked.includes(clientId);
}

async function planForFirm(db: Database, firmId: string, planId: string) {
  const [row] = await db
    .select()
    .from(clientPaymentPlans)
    .where(and(eq(clientPaymentPlans.id, planId), eq(clientPaymentPlans.firmId, firmId)))
    .limit(1);
  return row ?? null;
}

export function createClientPaymentPlansRouter(deps: ClientPaymentPlansDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // List a client's plans (most recent first).
  router.get('/', requirePermission(deps, 'payment:read'), async (req: Request, res: Response) => {
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const clientId = String(req.query['clientId'] ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
      res.status(400).json({ error: 'invalid_client_id' });
      return;
    }
    const s = req.staffSession!;
    if (await clientBlocked(deps, req, clientId)) {
      res.json({ items: [] });
      return;
    }
    const items = await deps.db
      .select()
      .from(clientPaymentPlans)
      .where(
        and(eq(clientPaymentPlans.firmId, s.firmId), eq(clientPaymentPlans.clientId, clientId)),
      )
      .orderBy(clientPaymentPlans.createdAt);
    res.json({ items });
  });

  // Create a plan against a saved, chargeable method.
  router.post(
    '/',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const s = req.staffSession!;
      const body = parsed.data;
      if (await clientBlocked(deps, req, body.clientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      // The method must be this firm+client's and ACTIVE (verified & chargeable).
      const [pm] = await deps.db
        .select()
        .from(paymentMethod)
        .where(
          and(
            eq(paymentMethod.id, body.paymentMethodId),
            eq(paymentMethod.firmId, s.firmId),
            eq(paymentMethod.clientId, body.clientId),
            eq(paymentMethod.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!pm) {
        res.status(404).json({ error: 'payment_method_not_found' });
        return;
      }
      if (pm.verificationStatus) {
        res.status(409).json({ error: 'payment_method_unverified', status: pm.verificationStatus });
        return;
      }
      const now = new Date();
      const [created] = await deps.db
        .insert(clientPaymentPlans)
        .values({
          firmId: s.firmId,
          clientId: body.clientId,
          paymentMethodId: body.paymentMethodId,
          frequency: body.frequency,
          nextRunDate: body.startDate,
          installmentCents: body.installmentCents,
          status: 'ACTIVE',
          authorizedByAppUserId: s.appUserId,
          authorizedAt: now,
          authorizationNote: body.authorizationNote ?? null,
          notes: body.notes ?? null,
          createdByAppUserId: s.appUserId,
        })
        .returning({ id: clientPaymentPlans.id });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'client_payment_plan',
        entityId: created!.id,
        actorAppUserId: s.appUserId,
        after: {
          clientId: body.clientId,
          frequency: body.frequency,
          installmentCents: body.installmentCents,
          startDate: body.startDate,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ ok: true, id: created!.id });
    },
  );

  // Edit installment / cadence / next run / notes on a live plan.
  router.patch(
    '/:id',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const s = req.staffSession!;
      const plan = await planForFirm(deps.db, s.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.status === 'COMPLETED' || plan.status === 'CANCELLED') {
        res.status(409).json({ error: 'plan_closed', status: plan.status });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.frequency !== undefined) patch['frequency'] = parsed.data.frequency;
      if (parsed.data.installmentCents !== undefined)
        patch['installmentCents'] = parsed.data.installmentCents;
      if (parsed.data.nextRunDate !== undefined) patch['nextRunDate'] = parsed.data.nextRunDate;
      if (parsed.data.notes !== undefined) patch['notes'] = parsed.data.notes;
      if (Object.keys(patch).length === 1) {
        res.status(400).json({ error: 'no_fields_to_update' });
        return;
      }
      await deps.db.update(clientPaymentPlans).set(patch).where(eq(clientPaymentPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_payment_plan',
        entityId: plan.id,
        actorAppUserId: s.appUserId,
        before: {
          frequency: plan.frequency,
          installmentCents: plan.installmentCents,
          nextRunDate: plan.nextRunDate,
        },
        after: patch,
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Pause an ACTIVE plan.
  router.post(
    '/:id/pause',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = PauseSchema.safeParse(req.body ?? {});
      const s = req.staffSession!;
      const plan = await planForFirm(deps.db, s.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.status !== 'ACTIVE') {
        res.status(409).json({ error: 'plan_not_active', status: plan.status });
        return;
      }
      await deps.db
        .update(clientPaymentPlans)
        .set({
          status: 'PAUSED',
          pausedReason: parsed.success ? (parsed.data.reason ?? 'staff_paused') : 'staff_paused',
          updatedAt: new Date(),
        })
        .where(eq(clientPaymentPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_payment_plan',
        entityId: plan.id,
        actorAppUserId: s.appUserId,
        after: { status: 'PAUSED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Resume a PAUSED plan (clears the failure counter + pause reason).
  router.post(
    '/:id/resume',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const s = req.staffSession!;
      const plan = await planForFirm(deps.db, s.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.status !== 'PAUSED') {
        res.status(409).json({ error: 'plan_not_paused', status: plan.status });
        return;
      }
      // If the next run is in the past, pull it to today so it charges promptly.
      const day = today();
      const nrd = plan.nextRunDate < day ? day : plan.nextRunDate;
      await deps.db
        .update(clientPaymentPlans)
        .set({
          status: 'ACTIVE',
          pausedReason: null,
          consecutiveFailureCount: 0,
          nextRunDate: nrd,
          updatedAt: new Date(),
        })
        .where(eq(clientPaymentPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_payment_plan',
        entityId: plan.id,
        actorAppUserId: s.appUserId,
        after: { status: 'ACTIVE' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Cancel a plan (terminal).
  router.post(
    '/:id/cancel',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const s = req.staffSession!;
      const plan = await planForFirm(deps.db, s.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.status === 'CANCELLED' || plan.status === 'COMPLETED') {
        res.status(409).json({ error: 'already_closed', status: plan.status });
        return;
      }
      await deps.db
        .update(clientPaymentPlans)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(clientPaymentPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'client_payment_plan',
        entityId: plan.id,
        actorAppUserId: s.appUserId,
        after: { status: 'CANCELLED' },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // Charge one installment immediately (manual "run now"). Mirrors the worker
  // tick's per-plan logic for a single plan and gives staff instant feedback.
  router.post(
    '/:id/run-now',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const s = req.staffSession!;
      const plan = await planForFirm(deps.db, s.firmId, req.params['id']!);
      if (!plan) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (plan.status !== 'ACTIVE' && plan.status !== 'PAUSED') {
        res.status(409).json({ error: 'plan_closed', status: plan.status });
        return;
      }
      const day = today();
      const open = await loadOpenInvoicesOldestFirst(deps.db, plan.firmId, plan.clientId);
      const outstanding = outstandingCents(open);
      if (outstanding <= 0) {
        await deps.db
          .update(clientPaymentPlans)
          .set({ status: 'COMPLETED', lastRunAt: new Date(), updatedAt: new Date() })
          .where(eq(clientPaymentPlans.id, plan.id));
        res.json({ ok: true, outcome: 'completed', reason: 'no_balance' });
        return;
      }
      const amount = Math.min(plan.installmentCents, outstanding);
      const allocations = buildAllocations(open, amount);

      // Atomic same-day claim — mirrors the worker so a run-now can't
      // double-charge alongside the cron tick or a concurrent second click.
      // (The shared Stripe idempotency key is a second line of defense.)
      const todayIso = new Date().toISOString().slice(0, 10);
      const claimed = await deps.db
        .update(clientPaymentPlans)
        .set({ lastRunAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(clientPaymentPlans.id, plan.id),
            or(
              isNull(clientPaymentPlans.lastRunAt),
              lt(sql`${clientPaymentPlans.lastRunAt}::date`, sql`${todayIso}::date`),
            ),
          ),
        )
        .returning({ id: clientPaymentPlans.id });
      if (claimed.length === 0) {
        res.status(409).json({ error: 'already_charged_today' });
        return;
      }

      const result = await chargeClientBalanceOffSession({
        db: deps.db,
        firmId: plan.firmId,
        clientId: plan.clientId,
        paymentMethodId: plan.paymentMethodId,
        amountCents: amount,
        allocations,
        createdById: s.appUserId,
        idempotencyKey: `payplan:${plan.id}:${day}`,
        metadata: { payment_plan_id: plan.id, trigger: 'manual' },
      });

      const requiresAction = result.ok ? result.requiresAction : false;
      const errorMsg = result.ok ? undefined : result.error;
      if (!result.ok || requiresAction) {
        const failCount = plan.consecutiveFailureCount + 1;
        const shouldPause = requiresAction || failCount >= plan.pauseThreshold;
        await deps.db
          .update(clientPaymentPlans)
          .set({
            consecutiveFailureCount: failCount,
            status: shouldPause ? 'PAUSED' : plan.status,
            pausedReason: shouldPause
              ? requiresAction
                ? 'authentication_required'
                : 'charge_failures'
              : plan.pausedReason,
            updatedAt: new Date(),
          })
          .where(eq(clientPaymentPlans.id, plan.id));
        await emitAudit(deps.db, {
          action: 'PAYMENT',
          entityType: 'client_payment_plan',
          entityId: plan.id,
          actorAppUserId: s.appUserId,
          after: { outcome: 'failed', requiresAction },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.status(result.ok ? 200 : 502).json({
          ok: false,
          outcome: requiresAction ? 'requires_action' : 'failed',
          error: errorMsg,
          receiptId: result.receiptId,
          paused: shouldPause,
        });
        return;
      }

      // Success — advance the schedule (or COMPLETE if the balance cleared).
      const cleared = amount >= outstanding;
      await deps.db
        .update(clientPaymentPlans)
        .set({
          status: cleared ? 'COMPLETED' : 'ACTIVE',
          nextRunDate: cleared ? plan.nextRunDate : nextRunDate(day, plan.frequency),
          consecutiveFailureCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(clientPaymentPlans.id, plan.id));
      await emitAudit(deps.db, {
        action: 'PAYMENT',
        entityType: 'client_payment_plan',
        entityId: plan.id,
        actorAppUserId: s.appUserId,
        after: { outcome: cleared ? 'completed' : 'charged', amountCents: amount },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({
        ok: true,
        outcome: cleared ? 'completed' : 'charged',
        amountCents: amount,
        receiptId: result.receiptId,
        settled: result.settled,
      });
    },
  );

  return router;
}
