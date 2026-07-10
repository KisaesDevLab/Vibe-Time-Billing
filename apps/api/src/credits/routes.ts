// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Credit memo endpoints (0056). A credit memo represents money the
// client has on file that hasn't been applied to a specific invoice
// yet — see the migration header for sources.
//
// Cross-entity application is allowed within firm: a credit owned by
// client A can fund an invoice on client B as long as both belong to
// the same firm. /credits enforces firm scope; the receive flow does
// the cross-check (see payments/routes.ts /receive).
//
// Apply path lives in payments/routes.ts /receive (writes credit_application
// + sibling payment row in one transaction). This router just handles
// list, manual create, and the two void actions.

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import type { Database } from '@vibe/db';
import { clients, creditApplications, creditMemos, invoices, payments } from '@vibe/db/schema';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { recomputeInvoicePaid } from '../payments/routes';

export interface CreditRoutesDeps extends RbacDeps {
  db: Database | null;
  redis?: Redis;
  requireStepUp?: (req: Request, res: Response, next: NextFunction) => unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CreateSchema = z.object({
  clientId: z.string().uuid(),
  issuedDate: z.string().regex(DATE_RE),
  originalAmountCents: z.number().int().positive(),
  reference: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const VoidMemoSchema = z.object({
  reason: z.string().min(1).max(400),
});

const VoidApplicationSchema = z.object({
  reason: z.string().max(400).nullable().optional(),
});

export function createCreditRouter(deps: CreditRoutesDeps): Router {
  const router = express.Router();
  addUuidIdGuard(router);

  // Stage 1B — step-up gating for sensitive credit ops. Void operations
  // always require fresh TOTP. If no step-up middleware is wired (tests
  // / mocked env), fall through to a permissive pass-through.
  const requireStepUp =
    deps.requireStepUp ?? ((_req: Request, _res: Response, next: NextFunction) => next());

  // =================================================================
  // GET / — list credits (with remaining balance)
  //   ?clientIds=a,b,c     filter to specific client(s); defaults to all
  //   ?status=OPEN&status=PARTIALLY_APPLIED  multi-value filter (default)
  //   ?status=ALL          include voided + fully-applied
  // =================================================================
  router.get('/', requirePermission(deps, 'credit:read'), async (req: Request, res: Response) => {
    const session = req.staffSession!;
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const idsRaw = req.query['clientIds'];
    const clientIds = Array.isArray(idsRaw)
      ? idsRaw.flatMap((s) => String(s).split(','))
      : typeof idsRaw === 'string'
        ? idsRaw.split(',')
        : [];
    const cleanedClientIds = Array.from(
      new Set(clientIds.map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s))),
    );

    const statusRaw = req.query['status'];
    const statusList = Array.isArray(statusRaw)
      ? statusRaw.map(String)
      : typeof statusRaw === 'string'
        ? [statusRaw]
        : ['OPEN', 'PARTIALLY_APPLIED'];
    const includeAll = statusList.includes('ALL');
    const statusFilter = includeAll
      ? null
      : statusList.filter((s) =>
          ['OPEN', 'PARTIALLY_APPLIED', 'FULLY_APPLIED', 'VOIDED'].includes(s),
        );

    const conds = [eq(creditMemos.firmId, session.firmId)];
    if (cleanedClientIds.length > 0) {
      conds.push(inArray(creditMemos.clientId, cleanedClientIds));
    }
    if (statusFilter && statusFilter.length > 0) {
      conds.push(inArray(creditMemos.status, statusFilter));
    }

    // LEFT JOIN credit_application (non-voided) and aggregate. Single
    // round-trip; no N+1.
    const rows = await deps.db
      .select({
        id: creditMemos.id,
        clientId: creditMemos.clientId,
        clientName: clients.name,
        issuedDate: creditMemos.issuedDate,
        originalAmountCents: creditMemos.originalAmountCents,
        source: creditMemos.source,
        reference: creditMemos.reference,
        notes: creditMemos.notes,
        status: creditMemos.status,
        sourceReceiptId: creditMemos.sourceReceiptId,
        sourcePaymentId: creditMemos.sourcePaymentId,
        voidedAt: creditMemos.voidedAt,
        voidReason: creditMemos.voidReason,
        createdAt: creditMemos.createdAt,
        appliedCents: sql<number>`
          COALESCE(SUM(
            CASE WHEN ${creditApplications.voidedAt} IS NULL
                 THEN ${creditApplications.amountCents}
                 ELSE 0
            END
          ), 0)::bigint
        `,
      })
      .from(creditMemos)
      .innerJoin(clients, eq(clients.id, creditMemos.clientId))
      .leftJoin(creditApplications, eq(creditApplications.creditMemoId, creditMemos.id))
      .where(and(...conds))
      .groupBy(creditMemos.id, clients.name)
      .orderBy(desc(creditMemos.issuedDate));

    const items = rows.map((r) => ({
      ...r,
      appliedCents: Number(r.appliedCents),
      remainingAmountCents: Number(r.originalAmountCents) - Number(r.appliedCents),
    }));
    res.json({ items });
  });

  // =================================================================
  // GET /:id — single memo with non-voided applications list
  // =================================================================
  router.get(
    '/:id',
    requirePermission(deps, 'credit:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ memo: null, applications: [] });
        return;
      }
      const [memo] = await deps.db
        .select()
        .from(creditMemos)
        .where(and(eq(creditMemos.id, req.params['id']!), eq(creditMemos.firmId, session.firmId)))
        .limit(1);
      if (!memo) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const apps = await deps.db
        .select({
          id: creditApplications.id,
          invoiceId: creditApplications.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          amountCents: creditApplications.amountCents,
          appliedAt: creditApplications.appliedAt,
          voidedAt: creditApplications.voidedAt,
          receiptId: creditApplications.receiptId,
        })
        .from(creditApplications)
        .innerJoin(invoices, eq(invoices.id, creditApplications.invoiceId))
        .where(eq(creditApplications.creditMemoId, memo.id))
        .orderBy(desc(creditApplications.appliedAt));
      const appliedCents = apps
        .filter((a) => a.voidedAt == null)
        .reduce((s, a) => s + Number(a.amountCents), 0);
      res.json({
        memo: {
          ...memo,
          appliedCents,
          remainingAmountCents: Number(memo.originalAmountCents) - appliedCents,
        },
        applications: apps,
      });
    },
  );

  // =================================================================
  // POST / — manual credit memo creation
  // =================================================================
  router.post('/', requirePermission(deps, 'credit:write'), async (req: Request, res: Response) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(201).json({ ok: true });
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
    const [row] = await deps.db
      .insert(creditMemos)
      .values({
        firmId: session.firmId,
        clientId: parsed.data.clientId,
        issuedDate: parsed.data.issuedDate,
        originalAmountCents: parsed.data.originalAmountCents,
        source: 'MANUAL',
        reference: parsed.data.reference ?? null,
        notes: parsed.data.notes ?? null,
        status: 'OPEN',
        createdById: session.appUserId,
      })
      .returning({ id: creditMemos.id });
    await emitAudit(deps.db, {
      action: 'PAYMENT',
      entityType: 'credit_memo',
      entityId: row?.id,
      actorAppUserId: session.appUserId,
      after: {
        kind: 'credit_create',
        source: 'MANUAL',
        clientId: parsed.data.clientId,
        amountCents: parsed.data.originalAmountCents,
        reference: parsed.data.reference,
      },
      ip: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
    }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
    res.status(201).json({ id: row?.id });
  });

  // =================================================================
  // POST /:id/void — void entire memo. Cascades non-voided applications.
  // =================================================================
  router.post(
    '/:id/void',
    requireStepUp,
    requirePermission(deps, 'credit:write'),
    async (req: Request, res: Response) => {
      const parsed = VoidMemoSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      try {
        const result = await deps.db.transaction(async (tx) => {
          const [memo] = await tx
            .select()
            .from(creditMemos)
            .where(
              and(eq(creditMemos.id, req.params['id']!), eq(creditMemos.firmId, session.firmId)),
            )
            .for('update')
            .limit(1);
          if (!memo) throw new HttpError(404, 'not_found');
          if (memo.status === 'VOIDED') throw new HttpError(409, 'already_voided');
          // Cascade-void any active applications.
          const activeApps = await tx
            .select({
              id: creditApplications.id,
              invoiceId: creditApplications.invoiceId,
              paymentId: creditApplications.paymentId,
            })
            .from(creditApplications)
            .where(
              and(
                eq(creditApplications.creditMemoId, memo.id),
                sql`${creditApplications.voidedAt} IS NULL`,
              ),
            )
            .for('update');
          for (const a of activeApps) {
            await voidApplicationInTx(tx, a, session.appUserId);
          }
          await tx
            .update(creditMemos)
            .set({
              status: 'VOIDED',
              voidedAt: new Date(),
              voidedById: session.appUserId,
              voidReason: parsed.data.reason,
              updatedAt: new Date(),
            })
            .where(eq(creditMemos.id, memo.id));
          return { memoId: memo.id, cascadedCount: activeApps.length };
        });
        await emitAudit(deps.db, {
          action: 'ARCHIVE',
          entityType: 'credit_memo',
          entityId: result.memoId,
          actorAppUserId: session.appUserId,
          after: {
            kind: 'credit_void',
            reason: parsed.data.reason,
            cascadedApplications: result.cascadedCount,
          },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.json({ ok: true, cascadedApplications: result.cascadedCount });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.code });
          return;
        }
        logger.error({ err }, '/credits/:id/void failed');
        res.status(500).json({ error: 'internal_error' });
      }
    },
  );

  // =================================================================
  // POST /:id/applications/:applicationId/void — void single application
  // =================================================================
  router.post(
    '/:id/applications/:applicationId/void',
    requireStepUp,
    requirePermission(deps, 'credit:write'),
    async (req: Request, res: Response) => {
      const parsed = VoidApplicationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true });
        return;
      }
      try {
        const result = await deps.db.transaction(async (tx) => {
          // Scope: memo must belong to firm, application must belong to memo.
          const [scope] = await tx
            .select({ memoId: creditMemos.id })
            .from(creditMemos)
            .where(
              and(eq(creditMemos.id, req.params['id']!), eq(creditMemos.firmId, session.firmId)),
            )
            .for('update')
            .limit(1);
          if (!scope) throw new HttpError(404, 'not_found');
          const [app] = await tx
            .select({
              id: creditApplications.id,
              invoiceId: creditApplications.invoiceId,
              paymentId: creditApplications.paymentId,
              voidedAt: creditApplications.voidedAt,
            })
            .from(creditApplications)
            .where(
              and(
                eq(creditApplications.id, req.params['applicationId']!),
                eq(creditApplications.creditMemoId, scope.memoId),
              ),
            )
            .for('update')
            .limit(1);
          if (!app) throw new HttpError(404, 'application_not_found');
          if (app.voidedAt != null) throw new HttpError(409, 'already_voided');
          await voidApplicationInTx(tx, app, session.appUserId);
          await recomputeCreditMemoStatus(tx, scope.memoId);
          return { memoId: scope.memoId, applicationId: app.id };
        });
        await emitAudit(deps.db, {
          action: 'ARCHIVE',
          entityType: 'credit_application',
          entityId: result.applicationId,
          actorAppUserId: session.appUserId,
          after: {
            kind: 'credit_application_void',
            memoId: result.memoId,
            reason: parsed.data.reason ?? null,
          },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
        res.json({ ok: true });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.code });
          return;
        }
        logger.error({ err }, '/credits/:id/applications/:appId/void failed');
        res.status(500).json({ error: 'internal_error' });
      }
    },
  );

  return router;
}

// ---------------------------------------------------------------------
// Helpers (also reused from payments/routes.ts /receive)
// ---------------------------------------------------------------------

/**
 * Void a single credit application inside an open transaction:
 *   1. Mark application voided_at = now()
 *   2. Flip sibling payment.status = 'REFUNDED' (drops from
 *      recomputeInvoicePaid's SUCCEEDED sum)
 *   3. Recompute the affected invoice's paid_cents
 *
 * Does NOT recompute the credit_memo's status — callers do that after
 * bulk operations.
 */
export async function voidApplicationInTx(
  tx: Database,
  app: { id: string; invoiceId: string; paymentId: string },
  actorId: string,
): Promise<void> {
  await tx
    .update(creditApplications)
    .set({ voidedAt: new Date(), voidedById: actorId })
    .where(eq(creditApplications.id, app.id));
  await tx
    .update(payments)
    .set({ status: 'REFUNDED', refundedAt: new Date() })
    .where(eq(payments.id, app.paymentId));
  await recomputeInvoicePaid(tx, app.invoiceId);
}

/**
 * Recompute credit_memo.status from the sum of non-voided applications.
 * Run after any application or void. Skips VOIDED memos (terminal state).
 */
export async function recomputeCreditMemoStatus(tx: Database, creditMemoId: string): Promise<void> {
  const [memo] = await tx
    .select({
      id: creditMemos.id,
      originalAmountCents: creditMemos.originalAmountCents,
      status: creditMemos.status,
    })
    .from(creditMemos)
    .where(eq(creditMemos.id, creditMemoId))
    .limit(1);
  if (!memo) return;
  if (memo.status === 'VOIDED') return; // terminal; don't bring back
  const [agg] = await tx
    .select({
      applied: sql<number>`COALESCE(SUM(${creditApplications.amountCents}), 0)::bigint`,
    })
    .from(creditApplications)
    .where(
      and(
        eq(creditApplications.creditMemoId, creditMemoId),
        sql`${creditApplications.voidedAt} IS NULL`,
      ),
    );
  const applied = Number(agg?.applied ?? 0);
  const original = Number(memo.originalAmountCents);
  const nextStatus =
    applied === 0 ? 'OPEN' : applied >= original ? 'FULLY_APPLIED' : 'PARTIALLY_APPLIED';
  if (nextStatus === memo.status) return;
  await tx
    .update(creditMemos)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(eq(creditMemos.id, creditMemoId));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
