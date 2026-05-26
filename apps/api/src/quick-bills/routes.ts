// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P24 — Quick-bill staff API (ADDENDUM-PROPOSAL-MODULE.md §P24).
//
// Quick-bills are ad-hoc invoices not tied to a proposal — the
// "$250 right now" path that doesn't justify standing up an
// engagement. The table + line items already exist from P01.
//
// State machine:
//   DRAFT → SENT  (mark-sent; locks the line items)
//   SENT  → PAID  (mark-paid; placeholder until P11 Stripe charge
//                  flow wires the real charge)
//   *     → VOID  (void from any non-VOID state with a reason)
//
// Endpoints:
//   GET    /api/staff/quick-bills                — list + filter
//   GET    /api/staff/quick-bills/:id            — detail incl. lines
//   POST   /api/staff/quick-bills                — create DRAFT + lines
//   PATCH  /api/staff/quick-bills/:id            — edit title /
//                                                  description /
//                                                  payment_method while
//                                                  still DRAFT
//   POST   /api/staff/quick-bills/:id/lines      — replace line items
//                                                  (DRAFT only)
//   POST   /api/staff/quick-bills/:id/send       — DRAFT → SENT;
//                                                  stamps sent_at
//   POST   /api/staff/quick-bills/:id/mark-paid  — SENT → PAID; stamps
//                                                  paid_at. Manual for
//                                                  now; P11 will hook
//                                                  webhook automation.
//   POST   /api/staff/quick-bills/:id/void       — any state → VOID

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clients, quickBillLineItems, quickBills } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface QuickBillRoutesDeps extends RbacDeps {
  db: Database | null;
}

const LineSchema = z.object({
  name: z.string().min(1).max(240),
  description: z.string().max(4000).optional(),
  qty: z.number().min(0.0001).max(99_999),
  unitPriceCents: z.number().int().min(0).max(999_999_999),
  sequence: z.number().int().min(0).max(999).optional(),
});

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  description: z.string().max(4000).optional(),
  paymentMethodId: z.string().uuid().nullable().optional(),
  lines: z.array(LineSchema).min(1).max(200),
});

const PatchSchema = z.object({
  description: z.string().max(4000).optional(),
  paymentMethodId: z.string().uuid().nullable().optional(),
});

const ReplaceLinesSchema = z.object({
  lines: z.array(LineSchema).min(1).max(200),
});

const VoidSchema = z.object({
  reason: z.string().min(1).max(400),
});

function sumLines(lines: z.infer<typeof LineSchema>[]): number {
  return lines.reduce((s, l) => s + Math.round(l.qty * l.unitPriceCents), 0);
}

export function createQuickBillRouter(deps: QuickBillRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  router.get('/', requirePermission(deps, 'invoice:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const conds = [eq(quickBills.firmId, session.firmId)];
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : null;
    if (state === 'DRAFT' || state === 'SENT' || state === 'PAID' || state === 'VOID') {
      conds.push(eq(quickBills.state, state));
    }
    const clientId = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : null;
    if (clientId && /^[0-9a-f-]{36}$/i.test(clientId)) {
      conds.push(eq(quickBills.clientId, clientId));
    }
    const items = await deps.db
      .select({
        id: quickBills.id,
        clientId: quickBills.clientId,
        state: quickBills.state,
        totalCents: quickBills.totalCents,
        description: quickBills.description,
        sentAt: quickBills.sentAt,
        paidAt: quickBills.paidAt,
        voidAt: quickBills.voidAt,
        createdAt: quickBills.createdAt,
        clientName: clients.name,
      })
      .from(quickBills)
      .leftJoin(clients, eq(clients.id, quickBills.clientId))
      .where(and(...conds))
      .orderBy(desc(quickBills.createdAt))
      .limit(500);
    res.json({ items });
  });

  router.get(
    '/:id',
    requirePermission(deps, 'invoice:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [qb] = await deps.db
        .select()
        .from(quickBills)
        .where(and(eq(quickBills.id, req.params['id']!), eq(quickBills.firmId, session.firmId)))
        .limit(1);
      if (!qb) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const lines = await deps.db
        .select()
        .from(quickBillLineItems)
        .where(eq(quickBillLineItems.quickBillId, qb.id))
        .orderBy(quickBillLineItems.sequence);
      res.json({ quickBill: qb, lines });
    },
  );

  router.post(
    '/',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      const total = sumLines(parsed.data.lines);
      const [row] = await deps.db
        .insert(quickBills)
        .values({
          firmId: session.firmId,
          clientId: parsed.data.clientId,
          state: 'DRAFT',
          totalCents: total,
          description: parsed.data.description ?? '',
          paymentMethodId: parsed.data.paymentMethodId ?? null,
          createdById: session.appUserId,
        })
        .returning({ id: quickBills.id });
      if (!row) throw new Error('quick_bill_insert_failed');
      await deps.db.insert(quickBillLineItems).values(
        parsed.data.lines.map((l, i) => ({
          quickBillId: row.id,
          name: l.name,
          description: l.description ?? '',
          qty: String(l.qty),
          unitPriceCents: l.unitPriceCents,
          sequence: l.sequence ?? i,
        })),
      );
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'quick_bill',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: {
          clientId: parsed.data.clientId,
          totalCents: total,
          lineCount: parsed.data.lines.length,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row.id, totalCents: total });
    },
  );

  router.patch(
    '/:id',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(quickBills)
        .where(and(eq(quickBills.id, req.params['id']!), eq(quickBills.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.state !== 'DRAFT') {
        res.status(409).json({ error: 'not_editable', state: prior.state });
        return;
      }
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.description != null) patch['description'] = parsed.data.description;
      if (parsed.data.paymentMethodId !== undefined) {
        patch['paymentMethodId'] = parsed.data.paymentMethodId;
      }
      await deps.db.update(quickBills).set(patch).where(eq(quickBills.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'quick_bill',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        before: prior,
        after: patch,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/lines',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = ReplaceLinesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [prior] = await deps.db
        .select()
        .from(quickBills)
        .where(and(eq(quickBills.id, req.params['id']!), eq(quickBills.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.state !== 'DRAFT') {
        res.status(409).json({ error: 'not_editable', state: prior.state });
        return;
      }
      const total = sumLines(parsed.data.lines);
      await deps.db.delete(quickBillLineItems).where(eq(quickBillLineItems.quickBillId, prior.id));
      await deps.db.insert(quickBillLineItems).values(
        parsed.data.lines.map((l, i) => ({
          quickBillId: prior.id,
          name: l.name,
          description: l.description ?? '',
          qty: String(l.qty),
          unitPriceCents: l.unitPriceCents,
          sequence: l.sequence ?? i,
        })),
      );
      await deps.db
        .update(quickBills)
        .set({ totalCents: total, updatedAt: new Date() })
        .where(eq(quickBills.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'quick_bill.lines',
        entityId: prior.id,
        actorAppUserId: session.appUserId,
        after: { totalCents: total, lineCount: parsed.data.lines.length },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, totalCents: total });
    },
  );

  router.post(
    '/:id/send',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(quickBills)
        .where(and(eq(quickBills.id, req.params['id']!), eq(quickBills.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.state !== 'DRAFT') {
        res.status(409).json({ error: 'not_sendable', state: row.state });
        return;
      }
      if (row.totalCents <= 0) {
        res.status(400).json({ error: 'empty_or_zero' });
        return;
      }
      const now = new Date();
      await deps.db
        .update(quickBills)
        .set({ state: 'SENT', sentAt: now, updatedAt: now })
        .where(eq(quickBills.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'quick_bill',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { state: 'DRAFT' },
        after: { state: 'SENT' },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/mark-paid',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(quickBills)
        .where(and(eq(quickBills.id, req.params['id']!), eq(quickBills.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.state !== 'SENT') {
        res.status(409).json({ error: 'not_payable', state: row.state });
        return;
      }
      const now = new Date();
      await deps.db
        .update(quickBills)
        .set({ state: 'PAID', paidAt: now, updatedAt: now })
        .where(eq(quickBills.id, row.id));
      await emitAudit(deps.db, {
        action: 'PAYMENT',
        entityType: 'quick_bill',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { state: 'SENT' },
        after: { state: 'PAID' },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  router.post(
    '/:id/void',
    requirePermission(deps, 'invoice:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = VoidSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.flatten() });
        return;
      }
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(quickBills)
        .where(and(eq(quickBills.id, req.params['id']!), eq(quickBills.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.state === 'VOID') {
        res.status(409).json({ error: 'already_void' });
        return;
      }
      const now = new Date();
      await deps.db
        .update(quickBills)
        .set({
          state: 'VOID',
          voidAt: now,
          voidReason: parsed.data.reason,
          updatedAt: now,
        })
        .where(eq(quickBills.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'quick_bill',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { state: row.state },
        after: { state: 'VOID', reason: parsed.data.reason },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
