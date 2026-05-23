// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff-side payment endpoints.
//
// Two distinct flows:
//   - /auto-apply (legacy): FIFO-applies a lump sum to a single client's
//     oldest open invoices. Hardened in 0055 to lock invoice rows and
//     recompute paid_cents idempotently from payment.amountCents.
//   - /receive (0055): user-driven allocation across one or many clients
//     with two modes:
//       * RECORD — writes payment rows directly (check / cash / manual ACH).
//       * CHARGE — creates a Stripe PaymentIntent; the webhook materializes
//                  the payments once Stripe confirms (single source of
//                  truth, no /confirm endpoint).
//
// The receive flow always creates a parent payment_receipt row that
// groups the N child payment rows from one operation.

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clientPortalAccess,
  clients,
  creditApplications,
  creditMemos,
  firmSettings,
  invoices,
  paymentReceipts,
  payments,
  portalIdentity,
} from '@vibe/db/schema';
import type { PaymentProvider } from '@vibe/core/payments';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';

export interface PaymentRoutesDeps extends RbacDeps {
  db: Database | null;
  stripe?: PaymentProvider | null;
  stripePublishableKey?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const AutoApplySchema = z.object({
  clientId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  receivedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional(),
  provider: z.enum(['STRIPE', 'CPACHARGE', 'MANUAL']).default('MANUAL'),
  reference: z.string().max(200).optional(),
});

const AllocationSchema = z.object({
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive(),
});

// 0056 — apply an existing credit memo against an invoice as part of
// the receive flow. Each application writes BOTH a credit_application
// row AND a sibling payment row with provider='CREDIT'.
const CreditApplicationInputSchema = z.object({
  creditMemoId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive(),
});

const ReceiveRecordSchema = z.object({
  payerClientId: z.string().uuid(),
  paymentDate: z.string().regex(DATE_RE),
  reference: z.string().max(200).optional().nullable(),
  // CREDIT_APPLY is only valid when amountReceivedCents === 0 (validated
  // in the handler since it's interdependent with the amount).
  paymentMethod: z.enum(['CHECK', 'CASH', 'ACH_MANUAL', 'OTHER', 'CARD_STRIPE', 'CREDIT_APPLY']),
  // Can be 0 when this is a pure credit-apply receipt.
  amountReceivedCents: z.number().int().nonnegative(),
  // Can be empty when this is a pure credit-apply receipt.
  allocations: z.array(AllocationSchema).max(200),
  creditApplications: z.array(CreditApplicationInputSchema).max(200).optional().default([]),
});
const ReceiveIntentSchema = z.object({
  payerClientId: z.string().uuid(),
  paymentDate: z.string().regex(DATE_RE),
  reference: z.string().max(200).optional().nullable(),
  paymentMethod: z.literal('CARD_STRIPE'),
  amountReceivedCents: z.number().int().positive(),
  allocations: z.array(AllocationSchema).min(1).max(200),
});

const PAYMENT_METHOD_LABELS = {
  CHECK: 'Check',
  CASH: 'Cash',
  ACH_MANUAL: 'ACH (manual)',
  OTHER: 'Other',
  CARD_STRIPE: 'Card (Stripe)',
  CREDIT_APPLY: 'Credit application',
} as const;

export function createPaymentRouter(deps: PaymentRoutesDeps): Router {
  const router = express.Router();
  // Reject non-UUID :id segments before Drizzle hands them to Postgres
  // (which 22P02s on bad UUIDs and bubbles up as a 500).
  addUuidIdGuard(router);

  // =================================================================
  // GET /config — feature flags for the staff payment UI
  // =================================================================
  router.get(
    '/config',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const stripeEnabled = Boolean(deps.stripe);
      let achEnabled = false;
      let ccEnabled = false;
      if (deps.db) {
        const [fs] = await deps.db
          .select({
            ach: firmSettings.achProcessingEnabled,
            cc: firmSettings.creditCardProcessingEnabled,
          })
          .from(firmSettings)
          .where(eq(firmSettings.firmId, session.firmId))
          .limit(1);
        achEnabled = Boolean(fs?.ach);
        ccEnabled = Boolean(fs?.cc);
      }
      res.json({
        stripeEnabled,
        stripePublishableKey: deps.stripePublishableKey ?? null,
        // ACH via Stripe is deferred (v1 = record-only). The flag is
        // surfaced so the UI can show ACH as a Record-mode option.
        achEnabled,
        ccEnabled,
        // CPACharge stays scaffolded — provider stub still returns
        // NOT_IMPLEMENTED.
        cpaChargeEnabled: false,
      });
    },
  );

  // =================================================================
  // GET /outstanding — unpaid invoices for one or many clients
  // =================================================================
  router.get(
    '/outstanding',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
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
      const cleaned = Array.from(
        new Set(clientIds.map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s))),
      );
      if (cleaned.length === 0) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          clientId: invoices.clientId,
          clientName: clients.name,
          issueDate: invoices.issueDate,
          dueDate: invoices.dueDate,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
          status: invoices.status,
        })
        .from(invoices)
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            inArray(invoices.clientId, cleaned),
            inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
          ),
        )
        .orderBy(asc(invoices.dueDate));
      res.json({
        items: items.map((i) => ({
          ...i,
          openCents: Number(i.totalCents) - Number(i.paidCents),
        })),
      });
    },
  );

  // =================================================================
  // GET /suggested-entities — other clients reachable from any portal
  // identity that has access to the given client
  // =================================================================
  router.get(
    '/suggested-entities',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const clientId = String(req.query['clientId'] ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(clientId)) {
        res.status(400).json({ error: 'clientId_required' });
        return;
      }
      const [scope] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, clientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'client_not_found' });
        return;
      }
      // Find every portal_identity that touches this client, then every
      // OTHER client those identities touch (excluding archived / inactive
      // access rows). The double-join ensures we only return live links.
      const rows = await deps.db
        .selectDistinct({
          clientId: clients.id,
          clientName: clients.name,
          identityFullName: portalIdentity.fullName,
        })
        .from(clientPortalAccess)
        .innerJoin(portalIdentity, eq(portalIdentity.id, clientPortalAccess.portalIdentityId))
        .innerJoin(clients, eq(clients.id, clientPortalAccess.clientId))
        .where(
          and(
            eq(clients.firmId, session.firmId),
            inArray(clients.status, ['ACTIVE', 'PROSPECT']),
            inArray(clientPortalAccess.status, ['ACTIVE', 'INVITED']),
            // sub-select: identities that have access to the target client
            sql`${clientPortalAccess.portalIdentityId} IN (
              SELECT ${clientPortalAccess.portalIdentityId}
                FROM ${clientPortalAccess}
               WHERE ${clientPortalAccess.clientId} = ${clientId}
                 AND ${clientPortalAccess.status} IN ('ACTIVE','INVITED')
            )`,
            sql`${clients.id} <> ${clientId}`,
          ),
        )
        .limit(50);
      res.json({ items: rows });
    },
  );

  // =================================================================
  // POST /receive — RECORD mode (manual check / cash / ACH-manual)
  // =================================================================
  router.post(
    '/receive',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const parsed = ReceiveRecordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      const data = parsed.data;
      if (data.paymentMethod === 'CARD_STRIPE') {
        // CARD_STRIPE must go through /receive/intent, never the record path.
        res.status(400).json({ error: 'use_intent_endpoint_for_card' });
        return;
      }

      const totalAllocated = data.allocations.reduce((s, a) => s + a.amountCents, 0);
      const isPureCreditApply = data.amountReceivedCents === 0;

      // ---- interdependent validation ----
      if (isPureCreditApply) {
        if (data.paymentMethod !== 'CREDIT_APPLY') {
          res.status(400).json({ error: 'credit_apply_requires_method', expected: 'CREDIT_APPLY' });
          return;
        }
        if (data.allocations.length > 0) {
          res.status(400).json({ error: 'pure_credit_apply_disallows_allocations' });
          return;
        }
        if (data.creditApplications.length === 0) {
          res.status(400).json({ error: 'no_credit_applications' });
          return;
        }
      } else {
        if (data.paymentMethod === 'CREDIT_APPLY') {
          res.status(400).json({ error: 'credit_apply_method_requires_zero_amount' });
          return;
        }
        if (totalAllocated > data.amountReceivedCents) {
          // Under-allocation creates a surplus credit (auto-overpayment).
          // Over-allocation is always wrong.
          res.status(400).json({
            error: 'allocations_exceed_amount',
            totalAllocated,
            amountReceivedCents: data.amountReceivedCents,
          });
          return;
        }
      }

      // Union of invoice ids touched (allocations + credit applications).
      // We lock all of them once so per-invoice cap checks see the truth.
      const allInvoiceIds = Array.from(
        new Set([
          ...data.allocations.map((a) => a.invoiceId),
          ...data.creditApplications.map((c) => c.invoiceId),
        ]),
      );
      const allocByInvoice = new Map(data.allocations.map((a) => [a.invoiceId, a.amountCents]));
      const creditAppsByInvoice = new Map<string, number>();
      for (const c of data.creditApplications) {
        creditAppsByInvoice.set(
          c.invoiceId,
          (creditAppsByInvoice.get(c.invoiceId) ?? 0) + c.amountCents,
        );
      }
      const creditMemoIds = Array.from(new Set(data.creditApplications.map((c) => c.creditMemoId)));

      try {
        const result = await deps.db.transaction(async (tx) => {
          // ---- invoice scope + lock ----
          const lockedInvoices =
            allInvoiceIds.length === 0
              ? []
              : await tx
                  .select({
                    id: invoices.id,
                    totalCents: invoices.totalCents,
                    paidCents: invoices.paidCents,
                    clientId: invoices.clientId,
                  })
                  .from(invoices)
                  .where(
                    and(inArray(invoices.id, allInvoiceIds), eq(invoices.firmId, session.firmId)),
                  )
                  .for('update');
          if (lockedInvoices.length !== allInvoiceIds.length) {
            throw new HttpError(403, 'invoice_scope_mismatch');
          }
          // ---- per-invoice cap: allocation + credits ≤ openBalance ----
          for (const inv of lockedInvoices) {
            const alloc = allocByInvoice.get(inv.id) ?? 0;
            const credit = creditAppsByInvoice.get(inv.id) ?? 0;
            const open = Number(inv.totalCents) - Number(inv.paidCents);
            if (alloc + credit > open) {
              throw new HttpError(400, 'invoice_overapplied', {
                invoiceId: inv.id,
                openCents: open,
                allocCents: alloc,
                creditCents: credit,
              });
            }
          }

          // ---- payer client ----
          const [payer] = await tx
            .select({ id: clients.id })
            .from(clients)
            .where(and(eq(clients.id, data.payerClientId), eq(clients.firmId, session.firmId)))
            .limit(1);
          if (!payer) throw new HttpError(404, 'payer_not_found');

          // ---- credit memo scope + lock + per-credit remaining check ----
          const memoRemainingById = new Map<string, number>();
          if (creditMemoIds.length > 0) {
            const memos = await tx
              .select({
                id: creditMemos.id,
                status: creditMemos.status,
                originalAmountCents: creditMemos.originalAmountCents,
              })
              .from(creditMemos)
              .where(
                and(inArray(creditMemos.id, creditMemoIds), eq(creditMemos.firmId, session.firmId)),
              )
              .for('update');
            if (memos.length !== creditMemoIds.length) {
              throw new HttpError(403, 'credit_memo_scope_mismatch');
            }
            for (const m of memos) {
              if (m.status === 'VOIDED') {
                throw new HttpError(409, 'credit_memo_voided', { creditMemoId: m.id });
              }
              if (m.status === 'FULLY_APPLIED') {
                throw new HttpError(409, 'credit_memo_fully_applied', { creditMemoId: m.id });
              }
              // Compute current remaining inside the lock.
              const [agg] = await tx
                .select({
                  applied: sql<number>`COALESCE(SUM(${creditApplications.amountCents}), 0)::bigint`,
                })
                .from(creditApplications)
                .where(
                  and(
                    eq(creditApplications.creditMemoId, m.id),
                    sql`${creditApplications.voidedAt} IS NULL`,
                  ),
                );
              const remaining = Number(m.originalAmountCents) - Number(agg?.applied ?? 0);
              memoRemainingById.set(m.id, remaining);
            }
            // Per-credit cap: sum of applications against this memo in
            // THIS request must fit in its remaining balance.
            const requestedByMemo = new Map<string, number>();
            for (const c of data.creditApplications) {
              requestedByMemo.set(
                c.creditMemoId,
                (requestedByMemo.get(c.creditMemoId) ?? 0) + c.amountCents,
              );
            }
            for (const [memoId, requested] of requestedByMemo) {
              const remaining = memoRemainingById.get(memoId) ?? 0;
              if (requested > remaining) {
                throw new HttpError(400, 'credit_application_exceeds_remaining', {
                  creditMemoId: memoId,
                  remainingCents: remaining,
                  requestedCents: requested,
                });
              }
            }
          }

          // ---- insert receipt ----
          // Pure credit-apply receipts use provider='CREDIT' and totalCents=0.
          // Mixed receipts (cash + credits) use provider='MANUAL' and totalCents=amountReceived.
          const [receipt] = await tx
            .insert(paymentReceipts)
            .values({
              firmId: session.firmId,
              payerClientId: data.payerClientId,
              paymentDate: data.paymentDate,
              reference: data.reference ?? null,
              paymentMethod: data.paymentMethod,
              mode: 'RECORD',
              totalCents: data.amountReceivedCents,
              provider: isPureCreditApply ? 'CREDIT' : 'MANUAL',
              providerChargeId: null,
              status: 'SUCCEEDED',
              allocationsPending: null,
              createdById: session.appUserId,
            })
            .returning({ id: paymentReceipts.id });
          if (!receipt) throw new HttpError(500, 'receipt_insert_failed');

          const receivedAt = new Date(data.paymentDate + 'T12:00:00Z');

          // ---- new-money payment rows ----
          for (const a of data.allocations) {
            await tx.insert(payments).values({
              invoiceId: a.invoiceId,
              amountCents: a.amountCents,
              feeCents: 0,
              provider: 'MANUAL',
              providerChargeId: data.reference ?? null,
              status: 'SUCCEEDED',
              receivedAt,
              receiptId: receipt.id,
            });
          }

          // ---- credit application rows (+ sibling payment rows) ----
          const touchedMemoIds = new Set<string>();
          for (const c of data.creditApplications) {
            const [creditPayment] = await tx
              .insert(payments)
              .values({
                invoiceId: c.invoiceId,
                amountCents: c.amountCents,
                feeCents: 0,
                provider: 'CREDIT',
                providerChargeId: c.creditMemoId, // breadcrumb back to memo
                status: 'SUCCEEDED',
                receivedAt,
                receiptId: receipt.id,
              })
              .returning({ id: payments.id });
            if (!creditPayment) throw new HttpError(500, 'credit_payment_insert_failed');
            await tx.insert(creditApplications).values({
              creditMemoId: c.creditMemoId,
              invoiceId: c.invoiceId,
              paymentId: creditPayment.id,
              amountCents: c.amountCents,
              appliedById: session.appUserId,
              receiptId: receipt.id,
            });
            touchedMemoIds.add(c.creditMemoId);
          }

          // ---- recompute paid_cents on every touched invoice ----
          for (const id of allInvoiceIds) {
            await recomputeInvoicePaid(tx, id);
          }

          // ---- recompute memo statuses on every touched memo ----
          for (const id of touchedMemoIds) {
            await recomputeMemoStatusInline(tx, id);
          }

          // ---- auto-overpayment credit ----
          let autoCreditId: string | null = null;
          const surplus = data.amountReceivedCents - totalAllocated;
          if (surplus > 0) {
            const [created] = await tx
              .insert(creditMemos)
              .values({
                firmId: session.firmId,
                clientId: data.payerClientId,
                issuedDate: data.paymentDate,
                originalAmountCents: surplus,
                source: 'OVERPAYMENT',
                reference: `Overpayment from receipt ${receipt.id}`,
                status: 'OPEN',
                sourceReceiptId: receipt.id,
                createdById: session.appUserId,
              })
              .returning({ id: creditMemos.id });
            autoCreditId = created?.id ?? null;
          }

          return {
            receiptId: receipt.id,
            invoicesTouched: allInvoiceIds.length,
            creditApplicationCount: data.creditApplications.length,
            surplusCreditId: autoCreditId,
            surplusCents: surplus,
          };
        });

        await emitAudit(deps.db, {
          action: 'PAYMENT',
          entityType: 'payment_receipt',
          entityId: result.receiptId,
          actorAppUserId: session.appUserId,
          after: {
            kind: isPureCreditApply ? 'receive_credit_apply' : 'receive_record',
            payerClientId: data.payerClientId,
            paymentMethod: data.paymentMethod,
            totalCents: data.amountReceivedCents,
            allocations: data.allocations,
            creditApplications: data.creditApplications,
            autoOverpaymentCreditId: result.surplusCreditId,
            surplusCents: result.surplusCents,
          },
          ip: clientIp(req),
          userAgent: req.header('user-agent') ?? null,
        }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

        res.status(201).json({
          ok: true,
          receiptId: result.receiptId,
          createdCredit:
            result.surplusCreditId != null
              ? { id: result.surplusCreditId, amountCents: result.surplusCents }
              : null,
        });
      } catch (err) {
        if (err instanceof HttpError) {
          res.status(err.status).json({ error: err.code, ...(err.detail ?? {}) });
          return;
        }
        logger.error({ err }, '/receive failed');
        res.status(500).json({ error: 'internal_error' });
      }
    },
  );

  // =================================================================
  // POST /receive/intent — CHARGE mode setup (Stripe PaymentIntent)
  // =================================================================
  router.post(
    '/receive/intent',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const parsed = ReceiveIntentSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(201).json({ ok: true });
        return;
      }
      if (!deps.stripe || !deps.stripe.createIntent) {
        res.status(409).json({ error: 'stripe_not_configured' });
        return;
      }
      const totalAllocated = parsed.data.allocations.reduce((s, a) => s + a.amountCents, 0);
      if (totalAllocated !== parsed.data.amountReceivedCents) {
        res.status(400).json({
          error: 'allocations_must_sum_to_amount',
          totalAllocated,
          amountReceivedCents: parsed.data.amountReceivedCents,
        });
        return;
      }
      // Firm must have CC processing on.
      const [fs] = await deps.db
        .select({ cc: firmSettings.creditCardProcessingEnabled })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, session.firmId))
        .limit(1);
      if (!fs?.cc) {
        res.status(409).json({ error: 'credit_card_processing_disabled' });
        return;
      }
      // Validate allocations belong to firm + sum within open balances —
      // but DO NOT lock invoices here; the webhook will lock+materialize.
      const locked = await deps.db
        .select({
          id: invoices.id,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
        })
        .from(invoices)
        .where(
          and(
            inArray(
              invoices.id,
              parsed.data.allocations.map((a) => a.invoiceId),
            ),
            eq(invoices.firmId, session.firmId),
          ),
        );
      if (locked.length !== parsed.data.allocations.length) {
        res.status(403).json({ error: 'invoice_scope_mismatch' });
        return;
      }
      const allocByInvoice = new Map(
        parsed.data.allocations.map((a) => [a.invoiceId, a.amountCents]),
      );
      for (const inv of locked) {
        const open = Number(inv.totalCents) - Number(inv.paidCents);
        const apply = allocByInvoice.get(inv.id) ?? 0;
        if (apply > open) {
          res.status(400).json({
            error: 'allocation_exceeds_open_balance',
            invoiceId: inv.id,
            openCents: open,
          });
          return;
        }
      }
      const [payer] = await deps.db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, parsed.data.payerClientId), eq(clients.firmId, session.firmId)))
        .limit(1);
      if (!payer) {
        res.status(404).json({ error: 'payer_not_found' });
        return;
      }

      // Create PENDING receipt first so we have a stable id for metadata.
      const [receipt] = await deps.db
        .insert(paymentReceipts)
        .values({
          firmId: session.firmId,
          payerClientId: parsed.data.payerClientId,
          paymentDate: parsed.data.paymentDate,
          reference: parsed.data.reference ?? null,
          paymentMethod: 'CARD_STRIPE',
          mode: 'CHARGE',
          totalCents: parsed.data.amountReceivedCents,
          provider: 'STRIPE',
          providerChargeId: null,
          status: 'PENDING',
          allocationsPending: parsed.data.allocations,
          createdById: session.appUserId,
        })
        .returning({ id: paymentReceipts.id });
      if (!receipt) {
        res.status(500).json({ error: 'receipt_insert_failed' });
        return;
      }

      // Create the Stripe PaymentIntent.
      const intent = await deps.stripe.createIntent({
        amountCents: parsed.data.amountReceivedCents,
        currency: 'USD',
        description: `Receipt ${receipt.id} (${PAYMENT_METHOD_LABELS.CARD_STRIPE})`,
        paymentMethodTypes: ['card'],
        metadata: {
          receiptId: receipt.id,
          firmId: session.firmId,
          payerClientId: parsed.data.payerClientId,
        },
      });
      if (!intent.ok) {
        await deps.db
          .update(paymentReceipts)
          .set({ status: 'FAILED', updatedAt: new Date() })
          .where(eq(paymentReceipts.id, receipt.id));
        res
          .status(502)
          .json({ error: 'stripe_intent_failed', detail: intent.errorMessage ?? null });
        return;
      }
      await deps.db
        .update(paymentReceipts)
        .set({ providerChargeId: intent.providerChargeId, updatedAt: new Date() })
        .where(eq(paymentReceipts.id, receipt.id));

      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'payment_receipt',
        entityId: receipt.id,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'receive_intent_created',
          payerClientId: parsed.data.payerClientId,
          totalCents: parsed.data.amountReceivedCents,
          providerChargeId: intent.providerChargeId,
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.status(201).json({
        ok: true,
        receiptId: receipt.id,
        clientSecret: intent.clientSecret,
        providerChargeId: intent.providerChargeId,
      });
    },
  );

  // =================================================================
  // GET /receive/:id — poll for CHARGE-mode confirmation status
  // =================================================================
  router.get(
    '/receive/:id',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ receipt: null, payments: [] });
        return;
      }
      const [receipt] = await deps.db
        .select()
        .from(paymentReceipts)
        .where(
          and(
            eq(paymentReceipts.id, req.params['id']!),
            eq(paymentReceipts.firmId, session.firmId),
          ),
        )
        .limit(1);
      if (!receipt) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await deps.db
        .select({
          id: payments.id,
          invoiceId: payments.invoiceId,
          amountCents: payments.amountCents,
          status: payments.status,
          receivedAt: payments.receivedAt,
        })
        .from(payments)
        .where(eq(payments.receiptId, receipt.id))
        .orderBy(asc(payments.receivedAt));
      res.json({ receipt, payments: rows });
    },
  );

  // =================================================================
  // POST /auto-apply (legacy, hardened in 0055)
  // =================================================================
  router.post(
    '/auto-apply',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const parsed = AutoApplySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ ok: true, applied: [] });
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

      const receivedAt = parsed.data.receivedAt ? new Date(parsed.data.receivedAt) : new Date();
      const applied: { invoiceId: string; invoiceNumber: string; amountCents: number }[] = [];
      let unappliedCents = parsed.data.amountCents;

      await deps.db.transaction(async (tx) => {
        // Lock open invoices for this client, oldest first.
        const open = await tx
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.firmId, session.firmId),
              eq(invoices.clientId, parsed.data.clientId),
              inArray(invoices.status, ['SENT', 'PARTIALLY_PAID', 'OVERDUE']),
            ),
          )
          .orderBy(asc(invoices.dueDate))
          .for('update');
        let remaining = parsed.data.amountCents;
        for (const inv of open) {
          if (remaining <= 0) break;
          const balance = Number(inv.totalCents) - Number(inv.paidCents);
          if (balance <= 0) continue;
          const apply = Math.min(remaining, balance);
          await tx.insert(payments).values({
            invoiceId: inv.id,
            amountCents: apply,
            feeCents: 0,
            provider: parsed.data.provider,
            providerChargeId: parsed.data.reference ?? null,
            status: 'SUCCEEDED',
            receivedAt,
          });
          await recomputeInvoicePaid(tx, inv.id);
          applied.push({
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber,
            amountCents: apply,
          });
          remaining -= apply;
        }
        unappliedCents = remaining;
      });

      await emitAudit(deps.db, {
        action: 'PAYMENT',
        entityType: 'client',
        entityId: parsed.data.clientId,
        actorAppUserId: session.appUserId,
        after: {
          kind: 'auto_apply',
          totalCents: parsed.data.amountCents,
          unappliedCents,
          appliedCount: applied.length,
          appliedInvoiceIds: applied.map((a) => a.invoiceId),
        },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));

      res.json({ ok: true, applied, unappliedCents });
    },
  );

  // =================================================================
  // GET /by-invoice/:invoiceId — payments for one invoice
  // =================================================================
  router.get(
    '/by-invoice/:invoiceId',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [inv] = await deps.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.id, req.params['invoiceId']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!inv) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select()
        .from(payments)
        .where(eq(payments.invoiceId, inv.id))
        .orderBy(desc(payments.receivedAt));
      res.json({ items });
    },
  );

  router.get(
    '/refunds',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const items = await deps.db
        .select({
          id: payments.id,
          invoiceId: payments.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          clientName: clients.name,
          amountCents: payments.amountCents,
          refundedAmountCents: payments.refundedAmountCents,
          refundedAt: payments.refundedAt,
          provider: payments.provider,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(
          and(
            eq(invoices.firmId, session.firmId),
            inArray(payments.status, ['REFUNDED', 'PARTIALLY_REFUNDED']),
          ),
        )
        .orderBy(desc(payments.refundedAt))
        .limit(500);
      res.json({ items });
    },
  );

  router.get(
    '/reconciliation',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], summary: { totalCents: 0, count: 0 } });
        return;
      }
      const start = typeof req.query['start'] === 'string' ? req.query['start'] : null;
      const end = typeof req.query['end'] === 'string' ? req.query['end'] : null;
      const provider = typeof req.query['provider'] === 'string' ? req.query['provider'] : null;
      const conds = [eq(invoices.firmId, session.firmId)];
      if (start && DATE_RE.test(start)) {
        conds.push(gte(payments.receivedAt, new Date(start)));
      }
      if (end && DATE_RE.test(end)) {
        conds.push(lte(payments.receivedAt, new Date(end)));
      }
      if (provider) conds.push(eq(payments.provider, provider));
      const rows = await deps.db
        .select({
          paymentId: payments.id,
          invoiceId: payments.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          clientId: invoices.clientId,
          clientName: clients.name,
          amountCents: payments.amountCents,
          feeCents: payments.feeCents,
          provider: payments.provider,
          providerChargeId: payments.providerChargeId,
          status: payments.status,
          receivedAt: payments.receivedAt,
          refundedAmountCents: payments.refundedAmountCents,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .where(and(...conds))
        .orderBy(desc(payments.receivedAt))
        .limit(2000);
      const totalCents = rows.reduce(
        (s, r) => s + Number(r.amountCents) - Number(r.refundedAmountCents ?? 0),
        0,
      );
      const [agg] = await deps.db
        .select({
          gross: sql<number>`COALESCE(SUM(${payments.amountCents}), 0)`,
          refunds: sql<number>`COALESCE(SUM(${payments.refundedAmountCents}), 0)`,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(and(...conds));
      res.json({
        items: rows,
        summary: {
          count: rows.length,
          totalCents,
          grossCents: Number(agg?.gross ?? 0),
          refundsCents: Number(agg?.refunds ?? 0),
        },
      });
    },
  );

  router.get(
    '/by-invoice/:invoiceId/refunds',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [] });
        return;
      }
      const [scope] = await deps.db
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.id, req.params['invoiceId']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!scope) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const items = await deps.db
        .select({
          id: payments.id,
          amountCents: payments.amountCents,
          refundedAmountCents: payments.refundedAmountCents,
          status: payments.status,
          providerChargeId: payments.providerChargeId,
          receivedAt: payments.receivedAt,
        })
        .from(payments)
        .where(
          and(
            eq(payments.invoiceId, req.params['invoiceId']!),
            inArray(payments.status, ['REFUNDED', 'PARTIALLY_REFUNDED']),
          ),
        )
        .orderBy(desc(payments.receivedAt));
      res.json({ items });
    },
  );

  return router;
}

/**
 * Idempotent recompute of invoice.paid_cents from successful payments.
 * Run inside a transaction that already holds the invoice row lock.
 *
 * Also updates status (PAID / PARTIALLY_PAID) and clears paidAt when the
 * row goes from PAID back to PARTIALLY_PAID (e.g., after a refund).
 */
export async function recomputeInvoicePaid(tx: Database, invoiceId: string): Promise<void> {
  const [agg] = await tx
    .select({
      paidCents: sql<number>`COALESCE(SUM(${payments.amountCents}), 0)::bigint`,
    })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'SUCCEEDED')));
  const [inv] = await tx
    .select({ total: invoices.totalCents, currentStatus: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (!inv) return;
  const paidCents = Number(agg?.paidCents ?? 0);
  const total = Number(inv.total);
  const nextStatus =
    paidCents >= total ? 'PAID' : paidCents > 0 ? 'PARTIALLY_PAID' : inv.currentStatus;
  await tx
    .update(invoices)
    .set({
      paidCents,
      status: nextStatus,
      paidAt: nextStatus === 'PAID' ? new Date() : null,
    })
    .where(eq(invoices.id, invoiceId));
}

/**
 * Inline credit-memo status recompute. Duplicates the helper in
 * credits/routes.ts to avoid an import cycle (credits already imports
 * recomputeInvoicePaid from here). Keep the two in sync.
 */
async function recomputeMemoStatusInline(tx: Database, creditMemoId: string): Promise<void> {
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
  if (memo.status === 'VOIDED') return;
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
    readonly detail?: Record<string, unknown>,
  ) {
    super(code);
  }
}

function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
