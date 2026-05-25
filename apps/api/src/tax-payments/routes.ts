// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// CP1 — Tax Payments staff API.
//
// Mounted at /api/staff/tax-payments. Six endpoints:
//   GET    /              — list, filtered by status / due-date window / clientId
//   GET    /:id           — single row detail
//   POST   /              — create (partner only; emits CREATE audit)
//   PATCH  /:id           — update mutable fields (partner only; emits UPDATE audit)
//   POST   /:id/mark-paid — flip to PAID with paid_date + confirmation_number
//   POST   /:id/void      — soft-delete via status='VOIDED'
//
// All mutations route through `emitAudit` so the audit log captures
// every state change with actor + before/after.
//
// State machine:
//   SCHEDULED → PAID    (mark-paid)
//   SCHEDULED → VOIDED  (void)
//   PAID      → (terminal — use credit-memo via AR flow to refund)

import express, { type Request, type Response, type Router } from 'express';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '@vibe/db';
import { clients, engagements, taxPayments } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard, uuidQueryParam } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface TaxPaymentRoutesDeps extends RbacDeps {
  db: Database | null;
}

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  engagementId: z.string().uuid().nullable().optional(),
  jurisdiction: z.string().min(1).max(120),
  paymentType: z.string().min(1).max(120),
  taxYear: z.number().int().min(1900).max(2200).optional(),
  amountCents: z.number().int().min(0),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().max(2000).optional(),
});

const PatchSchema = z.object({
  jurisdiction: z.string().min(1).max(120).optional(),
  paymentType: z.string().min(1).max(120).optional(),
  taxYear: z.number().int().min(1900).max(2200).nullable().optional(),
  amountCents: z.number().int().min(0).optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const MarkPaidSchema = z.object({
  paidDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confirmationNumber: z.string().max(120).optional(),
});

const VoidSchema = z.object({ reason: z.string().min(1).max(400) });

export function createTaxPaymentRouter(deps: TaxPaymentRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // ----- list --------------------------------------------------------

  router.get(
    '/',
    requirePermission(deps, 'tax_payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const conds = [eq(taxPayments.firmId, session.firmId)];
      const clientFilter = uuidQueryParam(req.query['clientId']);
      if (clientFilter && clientFilter !== 'invalid') {
        conds.push(eq(taxPayments.clientId, clientFilter));
      }
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      if (status === 'SCHEDULED' || status === 'PAID' || status === 'VOIDED') {
        conds.push(eq(taxPayments.status, status));
      }
      const dueFrom = typeof req.query['dueFrom'] === 'string' ? req.query['dueFrom'] : null;
      if (dueFrom && /^\d{4}-\d{2}-\d{2}$/.test(dueFrom)) {
        conds.push(gte(taxPayments.dueDate, dueFrom));
      }
      const dueTo = typeof req.query['dueTo'] === 'string' ? req.query['dueTo'] : null;
      if (dueTo && /^\d{4}-\d{2}-\d{2}$/.test(dueTo)) {
        conds.push(lte(taxPayments.dueDate, dueTo));
      }
      const items = await deps.db
        .select()
        .from(taxPayments)
        .where(and(...conds))
        .orderBy(desc(taxPayments.dueDate))
        .limit(500);
      res.json({ items });
    },
  );

  // ----- detail ------------------------------------------------------

  router.get(
    '/:id',
    requirePermission(deps, 'tax_payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const [row] = await deps.db
        .select()
        .from(taxPayments)
        .where(and(eq(taxPayments.id, req.params['id']!), eq(taxPayments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ taxPayment: row });
    },
  );

  // ----- create ------------------------------------------------------

  router.post(
    '/',
    requirePermission(deps, 'tax_payment:write'),
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
      // Client must belong to the firm.
      const [client] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!client) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      // If engagement supplied, it must belong to that client.
      if (parsed.data.engagementId) {
        const [eng] = await deps.db
          .select({ id: engagements.id })
          .from(engagements)
          .where(
            and(
              eq(engagements.id, parsed.data.engagementId),
              eq(engagements.clientId, parsed.data.clientId),
            ),
          )
          .limit(1);
        if (!eng) {
          res.status(400).json({ error: 'engagement_not_in_client' });
          return;
        }
      }
      const [row] = await deps.db
        .insert(taxPayments)
        .values({
          firmId: session.firmId,
          clientId: parsed.data.clientId,
          engagementId: parsed.data.engagementId ?? null,
          jurisdiction: parsed.data.jurisdiction,
          paymentType: parsed.data.paymentType,
          taxYear: parsed.data.taxYear ?? null,
          amountCents: parsed.data.amountCents,
          dueDate: parsed.data.dueDate,
          notes: parsed.data.notes ?? null,
          status: 'SCHEDULED',
          createdById: session.appUserId,
        })
        .returning({ id: taxPayments.id });
      if (!row) throw new Error('tax_payment_insert_failed');
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'tax_payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: {
          clientId: parsed.data.clientId,
          jurisdiction: parsed.data.jurisdiction,
          paymentType: parsed.data.paymentType,
          amountCents: parsed.data.amountCents,
          dueDate: parsed.data.dueDate,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.status(201).json({ id: row.id });
    },
  );

  // ----- patch (only when SCHEDULED) ---------------------------------

  router.patch(
    '/:id',
    requirePermission(deps, 'tax_payment:write'),
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
        .from(taxPayments)
        .where(and(eq(taxPayments.id, req.params['id']!), eq(taxPayments.firmId, session.firmId)))
        .limit(1);
      if (!prior) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (prior.status !== 'SCHEDULED') {
        res.status(409).json({ error: 'not_editable', currentStatus: prior.status });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (parsed.data.jurisdiction != null) patch['jurisdiction'] = parsed.data.jurisdiction;
      if (parsed.data.paymentType != null) patch['paymentType'] = parsed.data.paymentType;
      if (parsed.data.taxYear !== undefined) patch['taxYear'] = parsed.data.taxYear;
      if (parsed.data.amountCents != null) patch['amountCents'] = parsed.data.amountCents;
      if (parsed.data.dueDate != null) patch['dueDate'] = parsed.data.dueDate;
      if (parsed.data.notes !== undefined) patch['notes'] = parsed.data.notes;
      patch['updatedAt'] = new Date();
      await deps.db.update(taxPayments).set(patch).where(eq(taxPayments.id, prior.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_payment',
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

  // ----- mark-paid ---------------------------------------------------

  router.post(
    '/:id/mark-paid',
    requirePermission(deps, 'tax_payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = MarkPaidSchema.safeParse(req.body);
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
        .from(taxPayments)
        .where(and(eq(taxPayments.id, req.params['id']!), eq(taxPayments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status !== 'SCHEDULED') {
        res.status(409).json({ error: 'not_schedulable', currentStatus: row.status });
        return;
      }
      await deps.db
        .update(taxPayments)
        .set({
          status: 'PAID',
          paidDate: parsed.data.paidDate,
          confirmationNumber: parsed.data.confirmationNumber ?? null,
          updatedAt: new Date(),
        })
        .where(eq(taxPayments.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { status: 'SCHEDULED' },
        after: {
          status: 'PAID',
          paidDate: parsed.data.paidDate,
          confirmationNumber: parsed.data.confirmationNumber ?? null,
        },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  // ----- void --------------------------------------------------------
  // Soft-delete. Only allowed from SCHEDULED — PAID rows route through
  // the existing AR credit-memo flow for refunds.

  router.post(
    '/:id/void',
    requirePermission(deps, 'tax_payment:write'),
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
        .from(taxPayments)
        .where(and(eq(taxPayments.id, req.params['id']!), eq(taxPayments.firmId, session.firmId)))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.status === 'VOIDED') {
        res.json({ ok: true, alreadyVoided: true });
        return;
      }
      if (row.status === 'PAID') {
        res.status(409).json({ error: 'cannot_void_paid', currentStatus: row.status });
        return;
      }
      await deps.db
        .update(taxPayments)
        .set({ status: 'VOIDED', updatedAt: new Date() })
        .where(eq(taxPayments.id, row.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'tax_payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        before: { status: row.status },
        after: { status: 'VOIDED', reason: parsed.data.reason },
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true });
    },
  );

  return router;
}
