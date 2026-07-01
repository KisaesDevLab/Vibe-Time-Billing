// SPDX-License-Identifier: Elastic-2.0
//
// Engagement expenses — out-of-pocket costs billed to the client at
// cost + markup%. Expenses carry no timekeeper and never produce
// adjustment_allocation rows, so they stay out of per-timekeeper
// realization (CLAUDE.md non-negotiable #4). This router is the entry
// surface (Time ▸ Expenses tab); the billing batch pulls them in and
// applies INCLUDE / DEFER / WRITE_OFF the same way it does time.

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, gte, isNull, lte, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clients, engagementExpenses, engagements } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { getBlockedClientIdsCached } from '../clients/access';
import { addUuidIdGuard } from '../lib/uuid-guard';

export interface ExpenseRoutesDeps extends RbacDeps {
  db: Database | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CreateSchema = z.object({
  engagementId: z.string().uuid(),
  expenseDate: z.string().regex(DATE_RE),
  description: z.string().min(1).max(500),
  costCents: z.number().int().nonnegative(),
  category: z.string().max(120).optional(),
  vendor: z.string().max(200).optional(),
});

const UpdateSchema = z.object({
  expenseDate: z.string().regex(DATE_RE).optional(),
  description: z.string().min(1).max(500).optional(),
  costCents: z.number().int().nonnegative().optional(),
  category: z.string().max(120).nullable().optional(),
  vendor: z.string().max(200).nullable().optional(),
});

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}

export function createExpensesRouter(deps: ExpenseRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ---- List ----------------------------------------------------------
  router.get(
    '/list',
    requirePermission(deps, 'time_entry:read:own'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ rows: [] });
        return;
      }
      const q = req.query;
      const conds = [
        eq(engagementExpenses.firmId, session.firmId),
        sql`${engagementExpenses.status} <> 'ARCHIVED'`,
      ];
      const blockedClientIds = await getBlockedClientIdsCached(
        deps,
        req,
        session.appUserId,
        session.firmId,
      );
      if (blockedClientIds.length) conds.push(notInArray(engagements.clientId, blockedClientIds));
      const start = typeof q['startDate'] === 'string' ? q['startDate'] : '';
      const end = typeof q['endDate'] === 'string' ? q['endDate'] : '';
      if (DATE_RE.test(start)) conds.push(gte(engagementExpenses.expenseDate, start));
      if (DATE_RE.test(end)) conds.push(lte(engagementExpenses.expenseDate, end));
      if (typeof q['clientId'] === 'string' && q['clientId'])
        conds.push(eq(engagements.clientId, q['clientId']));
      if (typeof q['engagementId'] === 'string' && q['engagementId'])
        conds.push(eq(engagementExpenses.engagementId, q['engagementId']));
      const pageSize = Math.min(
        500,
        Math.max(1, parseInt(String(q['pageSize'] ?? '500'), 10) || 500),
      );

      const rows = await deps.db
        .select({
          id: engagementExpenses.id,
          expenseDate: engagementExpenses.expenseDate,
          description: engagementExpenses.description,
          costCents: engagementExpenses.costCents,
          category: engagementExpenses.category,
          vendor: engagementExpenses.vendor,
          status: engagementExpenses.status,
          billingBatchId: engagementExpenses.billingBatchId,
          engagementId: engagements.id,
          engagementName: engagements.name,
          clientId: clients.id,
          clientName: clients.name,
        })
        .from(engagementExpenses)
        .innerJoin(engagements, eq(engagements.id, engagementExpenses.engagementId))
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(...conds))
        .orderBy(desc(engagementExpenses.expenseDate))
        .limit(pageSize);

      res.json({ rows });
    },
  );

  // ---- Create --------------------------------------------------------
  router.post('/', requirePermission(deps, 'time_entry:create'), async (req, res) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    // Engagement must belong to the caller's firm.
    const [eng] = await deps.db
      .select({ id: engagements.id, clientId: engagements.clientId })
      .from(engagements)
      .innerJoin(clients, eq(clients.id, engagements.clientId))
      .where(and(eq(engagements.id, parsed.data.engagementId), eq(clients.firmId, session.firmId)))
      .limit(1);
    if (!eng) {
      res.status(404).json({ error: 'engagement_not_found' });
      return;
    }
    const [row] = await deps.db
      .insert(engagementExpenses)
      .values({
        firmId: session.firmId,
        engagementId: parsed.data.engagementId,
        expenseDate: parsed.data.expenseDate,
        description: parsed.data.description,
        costCents: parsed.data.costCents,
        category: parsed.data.category ?? null,
        vendor: parsed.data.vendor ?? null,
        createdById: session.appUserId,
      })
      .returning({ id: engagementExpenses.id });

    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'engagement_expense',
      entityId: row!.id,
      actorAppUserId: session.appUserId,
      after: parsed.data,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.status(201).json({ id: row!.id });
  });

  // ---- Update --------------------------------------------------------
  router.patch('/:id', requirePermission(deps, 'time_entry:create'), async (req, res) => {
    const parsed = UpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [existing] = await deps.db
      .select({
        id: engagementExpenses.id,
        firmId: engagementExpenses.firmId,
        billingBatchId: engagementExpenses.billingBatchId,
        status: engagementExpenses.status,
      })
      .from(engagementExpenses)
      .where(eq(engagementExpenses.id, req.params['id']!))
      .limit(1);
    if (!existing || existing.firmId !== session.firmId || existing.status === 'ARCHIVED') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // An expense already pulled into a batch is locked — release it (DEFER)
    // from the batch first if you need to edit it.
    if (existing.billingBatchId) {
      res.status(409).json({ error: 'expense_in_batch' });
      return;
    }
    await deps.db
      .update(engagementExpenses)
      .set({
        ...(parsed.data.expenseDate !== undefined ? { expenseDate: parsed.data.expenseDate } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.costCents !== undefined ? { costCents: parsed.data.costCents } : {}),
        ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
        ...(parsed.data.vendor !== undefined ? { vendor: parsed.data.vendor } : {}),
        updatedAt: new Date(),
      })
      .where(eq(engagementExpenses.id, existing.id));

    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'engagement_expense',
      entityId: existing.id,
      actorAppUserId: session.appUserId,
      after: parsed.data,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.json({ ok: true });
  });

  // ---- Soft delete ---------------------------------------------------
  router.delete('/:id', requirePermission(deps, 'time_entry:create'), async (req, res) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const [existing] = await deps.db
      .select({
        id: engagementExpenses.id,
        firmId: engagementExpenses.firmId,
        billingBatchId: engagementExpenses.billingBatchId,
        status: engagementExpenses.status,
      })
      .from(engagementExpenses)
      .where(eq(engagementExpenses.id, req.params['id']!))
      .limit(1);
    if (!existing || existing.firmId !== session.firmId || existing.status === 'ARCHIVED') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (existing.billingBatchId) {
      res.status(409).json({ error: 'expense_in_batch' });
      return;
    }
    await deps.db
      .update(engagementExpenses)
      .set({ status: 'ARCHIVED', updatedAt: new Date() })
      .where(
        and(eq(engagementExpenses.id, existing.id), isNull(engagementExpenses.billingBatchId)),
      );

    await emitAudit(deps.db, {
      action: 'ARCHIVE',
      entityType: 'engagement_expense',
      entityId: existing.id,
      actorAppUserId: session.appUserId,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.json({ ok: true });
  });

  return router;
}
