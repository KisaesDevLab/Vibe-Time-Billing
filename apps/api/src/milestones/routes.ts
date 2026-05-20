// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Milestone endpoints (Phase 10 #1-#9). Per-engagement milestone plans
// for FIXED_FEE_WITH_MILESTONES engagements. Each milestone becomes an
// invoice line item when triggered (manual or date-based).

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  engagements,
  invoiceLineItems,
  invoices,
  milestonePlans,
  milestones,
} from '@vibe/db/schema';
import { formatInvoiceNumber } from '@vibe/core/invoicing';
import { sql as drizzleSql } from 'drizzle-orm';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { logger } from '../logger';

export interface MilestoneRoutesDeps extends RbacDeps {
  db: Database | null;
}

const PlanCreateSchema = z.object({
  engagementId: z.string().uuid(),
  totalFeeCents: z.number().int().positive(),
  milestones: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        amountCents: z.number().int().positive(),
        sequence: z.number().int().min(1).max(100),
        triggerType: z.enum(['DATE', 'EVENT', 'MANUAL']),
        triggerDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        triggerEventKey: z.string().max(80).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export function createMilestoneRouter(deps: MilestoneRoutesDeps): Router {
  const router = express.Router();

  router.get(
    '/by-engagement/:engagementId',
    requirePermission(deps, 'engagement:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ plan: null, milestones: [] });
        return;
      }
      const ok = await engagementInFirm(deps.db, session.firmId, req.params['engagementId']!);
      if (!ok) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [plan] = await deps.db
        .select()
        .from(milestonePlans)
        .where(eq(milestonePlans.engagementId, req.params['engagementId']!))
        .limit(1);
      if (!plan) {
        res.json({ plan: null, milestones: [] });
        return;
      }
      const ms = await deps.db
        .select()
        .from(milestones)
        .where(eq(milestones.planId, plan.id))
        .orderBy(asc(milestones.sequence));
      res.json({ plan, milestones: ms });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'engagement:write'),
    async (req: Request, res: Response) => {
      const parsed = PlanCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const ok = await engagementInFirm(deps.db, session.firmId, parsed.data.engagementId);
      if (!ok) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const sumMilestones = parsed.data.milestones.reduce((s, m) => s + m.amountCents, 0);
      if (sumMilestones !== parsed.data.totalFeeCents) {
        res
          .status(400)
          .json({
            error: 'milestones_must_sum_to_total',
            sum: sumMilestones,
            total: parsed.data.totalFeeCents,
          });
        return;
      }
      const planId = await deps.db.transaction(async (tx) => {
        const [plan] = await tx
          .insert(milestonePlans)
          .values({
            engagementId: parsed.data.engagementId,
            totalFeeCents: parsed.data.totalFeeCents,
          })
          .returning({ id: milestonePlans.id });
        if (!plan) throw new Error('plan insert failed');
        await tx.insert(milestones).values(
          parsed.data.milestones.map((m) => ({
            planId: plan.id,
            name: m.name,
            amountCents: m.amountCents,
            sequence: m.sequence,
            triggerType: m.triggerType,
            triggerDate: m.triggerDate ?? null,
            triggerEventKey: m.triggerEventKey ?? null,
          })),
        );
        return plan.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'milestone_plan',
        entityId: planId,
        actorAppUserId: session.appUserId,
        after: {
          engagementId: parsed.data.engagementId,
          totalFeeCents: parsed.data.totalFeeCents,
          milestoneCount: parsed.data.milestones.length,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: planId });
    },
  );

  router.post(
    '/:milestoneId/trigger',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      const [ms] = await deps.db
        .select()
        .from(milestones)
        .where(eq(milestones.id, req.params['milestoneId']!))
        .limit(1);
      if (!ms) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (ms.status !== 'PENDING') {
        res.status(409).json({ error: 'milestone_not_pending', status: ms.status });
        return;
      }
      const [plan] = await deps.db
        .select()
        .from(milestonePlans)
        .where(eq(milestonePlans.id, ms.planId))
        .limit(1);
      if (!plan) {
        res.status(404).json({ error: 'plan_not_found' });
        return;
      }
      const ok = await engagementInFirm(deps.db, session.firmId, plan.engagementId);
      if (!ok) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const [eng] = await deps.db
        .select()
        .from(engagements)
        .where(eq(engagements.id, plan.engagementId))
        .limit(1);
      if (!eng) {
        res.status(404).json({ error: 'engagement_not_found' });
        return;
      }
      const [client] = await deps.db
        .select()
        .from(clients)
        .where(eq(clients.id, eng.clientId))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const issueDate = new Date().toISOString().slice(0, 10);
      const dueDate = new Date(Date.now() + client.termsDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const [maxNum] = await deps.db
        .select({
          n: drizzleSql<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
        })
        .from(invoices)
        .where(eq(invoices.firmId, session.firmId));
      const invoiceNumber = formatInvoiceNumber({
        config: { prefix: 'INV', yearPart: 'FOUR_DIGIT' },
        sequence: Number(maxNum?.n ?? 0) + 1,
        issueDate,
      });
      const invoiceId = await deps.db.transaction(async (tx) => {
        const [inv] = await tx
          .insert(invoices)
          .values({
            firmId: session.firmId,
            clientId: client.id,
            primaryEngagementId: eng.id,
            invoiceNumber,
            issueDate,
            dueDate,
            subtotalCents: Number(ms.amountCents),
            feeCents: 0,
            totalCents: Number(ms.amountCents),
            status: 'DRAFT',
          })
          .returning({ id: invoices.id });
        if (!inv) throw new Error('invoice insert failed');
        await tx.insert(invoiceLineItems).values({
          invoiceId: inv.id,
          kind: 'MILESTONE',
          description: `Milestone: ${ms.name}`,
          amountCents: Number(ms.amountCents),
          engagementId: eng.id,
          sourceRefType: 'milestone',
          sourceRefId: ms.id,
          sortOrder: 0,
        });
        await tx
          .update(milestones)
          .set({
            status: 'INVOICED',
            triggeredAt: new Date(),
            invoiceId: inv.id,
          })
          .where(eq(milestones.id, ms.id));
        return inv.id;
      });
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'invoice',
        entityId: invoiceId,
        actorAppUserId: session.appUserId,
        after: {
          invoiceNumber,
          kind: 'milestone',
          milestoneId: ms.id,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ invoiceId, invoiceNumber });
    },
  );

  return router;
}

async function engagementInFirm(
  db: Database,
  firmId: string,
  engagementId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: engagements.id })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(and(eq(engagements.id, engagementId), eq(clients.firmId, firmId)))
    .limit(1);
  return Boolean(row);
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
