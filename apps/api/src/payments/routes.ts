// SPDX-License-Identifier: Elastic-2.0
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
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  achReturns,
  clientContacts,
  clientPortalAccess,
  clients,
  creditApplications,
  creditMemos,
  firmSettings,
  invoices,
  paymentMethod,
  paymentMethodTypes,
  paymentReceipts,
  payments,
  persons,
  portalIdentity,
} from '@vibe/db/schema';
import type { PaymentProvider } from '@vibe/core/payments';
import { formatDateUS, formatMoneyCents } from '@vibe/core/invoicing';
import {
  promoteEscrowFilesForInvoice,
  sendDeliverableUnlockedNotifications,
} from '../files/promote-on-paid';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { recordOutbound } from '../clients/communications';
import { addUuidIdGuard } from '../lib/uuid-guard';
import { logger } from '../logger';
import { loadReceiptDoc, renderPaymentReceiptHtml } from './receipt-doc';
import { sendToPrinter } from '../print-gateway/send';
import { createStripeProvider } from './stripe';
import { loadFirmStripeConfig } from './stripe-resolver';
import { chargeClientBalanceOffSession } from './off-session-charge';
import { getBlockedClientIdsCached } from '../clients/access';
import { recomputeInvoicePaid, recomputeInvoicePaidReturnsFullyPaid } from './recompute';

// Resolve the Stripe provider + publishable key for a firm, preferring the
// firm's DB-stored keys (Admin → Billing → Stripe Connect) over the boot-time
// env provider. This is what lets the Charge button / pay-links work from keys
// pasted in the UI without setting appliance env vars.
async function resolveStripeForFirm(
  deps: PaymentRoutesDeps,
  firmId: string,
): Promise<{ provider: PaymentProvider | null; publishableKey: string | null }> {
  if (deps.db) {
    const cfg = await loadFirmStripeConfig(deps.db, firmId);
    if (cfg?.secretKey) {
      return {
        provider: createStripeProvider({ secretKey: cfg.secretKey }),
        publishableKey: cfg.publishableKey ?? deps.stripePublishableKey ?? null,
      };
    }
  }
  return { provider: deps.stripe ?? null, publishableKey: deps.stripePublishableKey ?? null };
}

export interface PaymentRoutesDeps extends RbacDeps {
  db: Database | null;
  stripe?: PaymentProvider | null;
  stripePublishableKey?: string | null;
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  /** Firm mailer (HTML + attachments) — used to email a payment receipt. */
  sendStaffMail?: (args: {
    to: string;
    subject: string;
    body: string;
    html?: string;
    attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  }) => Promise<void>;
  portalBaseUrl?: string;
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

// 0089 — `paymentMethod` is no longer a closed enum; it's an
// UPPER_SNAKE catalog key from payment_method_type. The handler
// validates the supplied key against the firm's active catalog plus
// the two synthetic values (CARD_STRIPE, CREDIT_APPLY) that the
// receive flow injects based on context — Stripe wired / open credit.
const PAYMENT_METHOD_KEY_RE = /^[A-Z][A-Z0-9_]{0,62}[A-Z0-9]$/;
const ReceiveRecordSchema = z.object({
  payerClientId: z.string().uuid(),
  paymentDate: z.string().regex(DATE_RE),
  reference: z.string().max(200).optional().nullable(),
  // CREDIT_APPLY is only valid when amountReceivedCents === 0 (validated
  // in the handler since it's interdependent with the amount).
  paymentMethod: z.string().regex(PAYMENT_METHOD_KEY_RE),
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

/** Derive a human payment channel for the Billing → Payments listing. */
function deriveChannel(
  provider: string,
  pmKind: string | null,
  receiptMethod: string | null,
  storedChannel?: string | null,
): string {
  // An explicit channel stamped at collect time wins (e.g. in-person Terminal).
  if (storedChannel === 'TERMINAL') return 'Terminal';
  if (storedChannel) return storedChannel;
  if (provider === 'CREDIT') return 'Credit';
  if (provider === 'MANUAL') {
    switch ((receiptMethod ?? '').toUpperCase()) {
      case 'CHECK':
        return 'Check';
      case 'CASH':
        return 'Cash';
      case 'ACH_MANUAL':
        return 'ACH (manual)';
      default:
        return 'Manual';
    }
  }
  // Stripe (online or Terminal). We can't always distinguish card-present from
  // online without a stored method type, so an unlabeled Stripe card reads as
  // "Card"; ACH PMs read as "ACH".
  if (pmKind === 'ACH') return 'ACH';
  if (pmKind === 'CARD') return 'Card';
  return 'Card';
}

function emptyReceivedSummary(): {
  count: number;
  grossCents: number;
  feesCents: number;
  netCents: number;
  refundsCents: number;
  pendingCount: number;
} {
  return { count: 0, grossCents: 0, feesCents: 0, netCents: 0, refundsCents: 0, pendingCount: 0 };
}

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
      const { provider, publishableKey } = await resolveStripeForFirm(deps, session.firmId);
      const stripeEnabled = Boolean(provider);
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
        stripePublishableKey: publishableKey,
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

      // 0089 — validate paymentMethod against the firm's catalog.
      // CREDIT_APPLY stays synthetic (not in catalog; injected when the
      // client has an open credit memo); every other value must resolve
      // to an active payment_method_type row.
      if (data.paymentMethod !== 'CREDIT_APPLY') {
        const [match] = await deps.db
          .select({ key: paymentMethodTypes.key })
          .from(paymentMethodTypes)
          .where(
            and(
              eq(paymentMethodTypes.firmId, session.firmId),
              eq(paymentMethodTypes.key, data.paymentMethod),
              eq(paymentMethodTypes.active, true),
            ),
          )
          .limit(1);
        if (!match) {
          res.status(400).json({
            error: 'unknown_payment_method',
            method: data.paymentMethod,
            hint: 'Add the method under Admin → Catalog → Payment methods.',
          });
          return;
        }
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
          const promotedInvoiceIds = new Set<string>();
          for (const id of allInvoiceIds) {
            const wasFullyPaid = await recomputeInvoicePaidReturnsFullyPaid(tx, id);
            if (wasFullyPaid) promotedInvoiceIds.add(id);
          }
          // Stage 3 — promote escrow files gated by any invoice that
          // tipped over to fully-paid in this transaction. Capture the
          // promoted counts so the post-commit block can fire
          // deliverable-unlocked notifications (P3.3).
          const promotedCounts: Array<{ invoiceId: string; count: number }> = [];
          for (const invId of promotedInvoiceIds) {
            try {
              const ids = await promoteEscrowFilesForInvoice(tx, {
                firmId: session.firmId,
                invoiceId: invId,
                actorAppUserId: session.appUserId,
              });
              if (ids.length > 0) promotedCounts.push({ invoiceId: invId, count: ids.length });
            } catch (err) {
              logger.error({ err, invoiceId: invId }, 'escrow promote in /receive failed');
            }
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
            promotedCounts,
            promotedInvoiceIds: Array.from(promotedInvoiceIds),
          };
        });

        // P3.3 — F.10 — after the receive transaction commits, fire the
        // deliverable-unlocked email to every portal identity on the
        // invoice's client. Runs outside the tx so a rollback can't leak
        // emails. Best-effort: failures are logged.
        for (const { invoiceId, count } of result.promotedCounts) {
          await sendDeliverableUnlockedNotifications(deps.db, {
            invoiceId,
            promotedFileCount: count,
            portalBaseUrl: deps.portalBaseUrl,
            sendEmail: deps.sendEmail,
          }).catch((err: unknown) =>
            logger.error({ err, invoiceId }, 'deliverable-unlocked dispatch failed (post-commit)'),
          );
        }

        // R3 — retainer activation. For every invoice that tipped to
        // fully-paid in this receipt, check whether it carries a
        // retainer_offer_id and run the activation handler if so.
        // Idempotent against re-receive; outside the receipt tx so an
        // activation failure doesn't roll back the payment.
        for (const invId of result.promotedInvoiceIds) {
          const [invRow] = await deps.db
            .select({
              retainerOfferId: invoices.retainerOfferId,
              retainerId: invoices.retainerId,
            })
            .from(invoices)
            .where(eq(invoices.id, invId))
            .limit(1);
          if (invRow?.retainerOfferId) {
            try {
              const { activateRetainerFromPaidInvoice } = await import('../retainers/activation');
              const r = await activateRetainerFromPaidInvoice(deps.db, invId, {
                actorAppUserId: session.appUserId,
                sendEmail: deps.sendEmail,
              });
              if (r.kind === 'error') {
                logger.error({ invoiceId: invId, reason: r.reason }, 'retainer activation error');
              }
            } catch (err) {
              logger.error({ err, invoiceId: invId }, 'retainer activation threw (post-commit)');
            }
          } else if (invRow?.retainerId) {
            // 0091 — firm-initiated retainer bill. Direct retainer link
            // bypasses the offer flow.
            try {
              const { activateRetainerFromDirectPaidInvoice } =
                await import('../retainers/activation');
              const r = await activateRetainerFromDirectPaidInvoice(deps.db, invId, {
                actorAppUserId: session.appUserId,
                sendEmail: deps.sendEmail,
              });
              if (r.kind === 'error') {
                logger.error(
                  { invoiceId: invId, reason: r.reason },
                  'retainer direct activation error',
                );
              }
            } catch (err) {
              logger.error(
                { err, invoiceId: invId },
                'retainer direct activation threw (post-commit)',
              );
            }
          }
        }

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
      const { provider: firmStripe } = await resolveStripeForFirm(deps, session.firmId);
      if (!firmStripe || !firmStripe.createIntent) {
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

      // Create the Stripe PaymentIntent (firm's resolved provider).
      const intent = await firmStripe.createIntent({
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
  // POST /receive/charge-saved — charge a client's saved method off-session
  // for a staff-specified amount/allocations. Settles via the same webhook as
  // the Elements Charge flow; the UI polls GET /receive/:id.
  // =================================================================
  const ChargeSavedSchema = z.object({
    payerClientId: z.string().uuid(),
    paymentMethodId: z.string().uuid(),
    paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reference: z.string().max(200).nullish(),
    amountReceivedCents: z.number().int().positive(),
    allocations: z.array(AllocationSchema).min(1).max(200),
  });
  router.post(
    '/receive/charge-saved',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ChargeSavedSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const body = parsed.data;
      // 0165 restricted-client guard.
      const blocked = await getBlockedClientIdsCached(deps, req, session.appUserId, session.firmId);
      if (blocked.includes(body.payerClientId)) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const allocSum = body.allocations.reduce((n, a) => n + a.amountCents, 0);
      if (allocSum !== body.amountReceivedCents) {
        res.status(400).json({ error: 'allocation_sum_mismatch' });
        return;
      }
      // The method must be this firm+client's, ACTIVE, and verified.
      const [pm] = await deps.db
        .select({
          kind: paymentMethod.kind,
          verificationStatus: paymentMethod.verificationStatus,
        })
        .from(paymentMethod)
        .where(
          and(
            eq(paymentMethod.id, body.paymentMethodId),
            eq(paymentMethod.firmId, session.firmId),
            eq(paymentMethod.clientId, body.payerClientId),
            eq(paymentMethod.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      if (!pm) {
        res.status(404).json({ error: 'payment_method_not_found' });
        return;
      }
      if (pm.verificationStatus) {
        res.status(409).json({ error: 'payment_method_unverified' });
        return;
      }
      // Firm-level processing toggle for the method kind.
      const [fs] = await deps.db
        .select({
          cc: firmSettings.creditCardProcessingEnabled,
          ach: firmSettings.achProcessingEnabled,
        })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, session.firmId))
        .limit(1);
      if (pm.kind === 'CARD' && !fs?.cc) {
        res.status(409).json({ error: 'credit_card_processing_disabled' });
        return;
      }
      if (pm.kind === 'ACH' && !fs?.ach) {
        res.status(409).json({ error: 'ach_processing_disabled' });
        return;
      }
      let out;
      try {
        out = await chargeClientBalanceOffSession({
          db: deps.db,
          firmId: session.firmId,
          clientId: body.payerClientId,
          paymentMethodId: body.paymentMethodId,
          amountCents: body.amountReceivedCents,
          allocations: body.allocations,
          paymentDate: body.paymentDate,
          createdById: session.appUserId,
          metadata: { source: 'receive_saved', reference: body.reference ?? '' },
        });
      } catch (err) {
        logger.error({ err }, 'charge-saved failed');
        res.status(502).json({ error: 'stripe_error' });
        return;
      }
      if (!out.ok) {
        res.status(400).json({ error: out.error, receiptId: out.receiptId });
        return;
      }
      await emitAudit(deps.db, {
        action: 'PAYMENT',
        entityType: 'payment_receipt',
        entityId: out.receiptId,
        actorAppUserId: session.appUserId,
        after: {
          payerClientId: body.payerClientId,
          amountCents: body.amountReceivedCents,
          method: pm.kind === 'CARD' ? 'CARD_STRIPE' : 'ACH_STRIPE',
          saved: true,
        },
      }).catch(() => undefined);
      res.json({
        ok: true,
        receiptId: out.receiptId,
        status: out.status,
        requiresAction: out.requiresAction,
        settled: out.settled,
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

  // Billing → Payments. Payment-grain listing of received payments with a
  // derived channel (Card / ACH / Terminal-as-Card / Check / Cash / Credit),
  // status, fees, and drill-through to the invoice. Filters: date range,
  // status, channel, and a client/invoice search. Summary covers gross, fees,
  // net, refunds, and in-flight (processing/pending) count.
  router.get(
    '/received',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], summary: emptyReceivedSummary() });
        return;
      }
      const start = typeof req.query['start'] === 'string' ? req.query['start'] : null;
      const end = typeof req.query['end'] === 'string' ? req.query['end'] : null;
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : null;
      const channel = typeof req.query['channel'] === 'string' ? req.query['channel'] : null;
      const q = (req.query['q'] ?? '').toString().trim();

      const conds = [eq(invoices.firmId, session.firmId)];
      if (start && DATE_RE.test(start)) conds.push(gte(payments.receivedAt, new Date(start)));
      if (end && DATE_RE.test(end))
        conds.push(lte(payments.receivedAt, new Date(`${end}T23:59:59.999Z`)));
      const STATUSES = [
        'PENDING',
        'SUCCEEDED',
        'FAILED',
        'REFUNDED',
        'PARTIALLY_REFUNDED',
      ] as const;
      if (status && (STATUSES as readonly string[]).includes(status)) {
        conds.push(eq(payments.status, status as (typeof STATUSES)[number]));
      }
      if (q) {
        const like = `%${q}%`;
        const expr = or(ilike(clients.name, like), ilike(invoices.invoiceNumber, like));
        if (expr) conds.push(expr);
      }

      const rows = await deps.db
        .select({
          paymentId: payments.id,
          receivedAt: payments.receivedAt,
          clientId: invoices.clientId,
          clientName: clients.name,
          invoiceId: payments.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          amountCents: payments.amountCents,
          feeCents: payments.feeCents,
          provider: payments.provider,
          status: payments.status,
          refundedAmountCents: payments.refundedAmountCents,
          storedChannel: payments.channel,
          voidedAt: payments.voidedAt,
          receiptId: payments.receiptId,
          pmKind: paymentMethod.kind,
          receiptMethod: paymentReceipts.paymentMethod,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .innerJoin(clients, eq(clients.id, invoices.clientId))
        .leftJoin(paymentMethod, eq(paymentMethod.id, payments.paymentMethodId))
        .leftJoin(paymentReceipts, eq(paymentReceipts.id, payments.receiptId))
        .where(and(...conds))
        .orderBy(desc(payments.receivedAt))
        .limit(1000);

      const withChannel = rows.map((r) => ({
        paymentId: r.paymentId,
        receivedAt: r.receivedAt,
        clientId: r.clientId,
        clientName: r.clientName,
        invoiceId: r.invoiceId,
        invoiceNumber: r.invoiceNumber,
        amountCents: Number(r.amountCents),
        feeCents: Number(r.feeCents),
        netCents: Number(r.amountCents) - Number(r.feeCents) - Number(r.refundedAmountCents ?? 0),
        provider: r.provider,
        status: r.status,
        refundedAmountCents: Number(r.refundedAmountCents ?? 0),
        channel: deriveChannel(r.provider, r.pmKind, r.receiptMethod, r.storedChannel),
        receiptId: r.receiptId,
        voided: r.voidedAt != null,
        // Only manually-recorded payments are editable/voidable from the UI;
        // Stripe-processed rows reverse via refunds.
        canEdit: r.provider === 'MANUAL' && r.voidedAt == null,
        canVoid: (r.provider === 'MANUAL' || r.provider === 'CREDIT') && r.voidedAt == null,
      }));
      const filtered = channel ? withChannel.filter((r) => r.channel === channel) : withChannel;

      const summary = filtered.reduce(
        (s, r) => {
          if (r.status === 'SUCCEEDED' && !r.voided) {
            s.grossCents += r.amountCents;
            s.feesCents += r.feeCents;
          }
          s.refundsCents += r.refundedAmountCents;
          if (r.status === 'PENDING' && !r.voided) s.pendingCount += 1;
          return s;
        },
        { count: filtered.length, grossCents: 0, feesCents: 0, refundsCents: 0, pendingCount: 0 },
      );
      res.json({
        items: filtered,
        summary: {
          ...summary,
          netCents: summary.grossCents - summary.feesCents - summary.refundsCents,
        },
      });
    },
  );

  // Edit a manually-recorded payment (amount / received date). Manual-only:
  // Stripe-processed rows are read-only (reverse via refund). Recomputes the
  // invoice's paid total + audits.
  const PaymentEditSchema = z.object({
    amountCents: z.number().int().positive().optional(),
    receivedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}/)
      .optional(),
  });
  router.patch(
    '/:id',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = PaymentEditSchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const [row] = await deps.db
        .select({
          id: payments.id,
          provider: payments.provider,
          voidedAt: payments.voidedAt,
          invoiceId: payments.invoiceId,
          firmId: invoices.firmId,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(and(eq(payments.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!row) return void res.status(404).json({ error: 'not_found' });
      if (row.provider !== 'MANUAL')
        return void res.status(409).json({ error: 'not_editable_provider' });
      if (row.voidedAt) return void res.status(409).json({ error: 'payment_voided' });
      const patch: Record<string, unknown> = {};
      if (parsed.data.amountCents != null) patch['amountCents'] = parsed.data.amountCents;
      if (parsed.data.receivedAt) patch['receivedAt'] = new Date(parsed.data.receivedAt);
      if (Object.keys(patch).length === 0) return void res.json({ ok: true });
      await deps.db.transaction(async (tx) => {
        await tx.update(payments).set(patch).where(eq(payments.id, row.id));
        await recomputeInvoicePaid(tx as unknown as Database, row.invoiceId);
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { ...patch, invoiceId: row.invoiceId },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed (payment edit)'));
      res.json({ ok: true });
    },
  );

  // Void a manually-recorded payment (or a credit application). Keeps the row,
  // reverses its effect on the invoice, and for credit applications restores
  // the credit memo balance. Audited.
  const VoidSchema = z.object({ reason: z.string().max(500).optional().nullable() });
  router.post(
    '/:id/void',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = VoidSchema.safeParse(req.body ?? {});
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const [row] = await deps.db
        .select({
          id: payments.id,
          provider: payments.provider,
          voidedAt: payments.voidedAt,
          invoiceId: payments.invoiceId,
          firmId: invoices.firmId,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(and(eq(payments.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!row) return void res.status(404).json({ error: 'not_found' });
      if (row.voidedAt) return void res.status(409).json({ error: 'already_voided' });
      if (row.provider !== 'MANUAL' && row.provider !== 'CREDIT') {
        return void res.status(409).json({ error: 'not_voidable_provider' });
      }
      const now = new Date();
      const touchedMemoIds: string[] = [];
      await deps.db.transaction(async (tx) => {
        await tx
          .update(payments)
          .set({
            voidedAt: now,
            voidedById: session.appUserId,
            voidReason: parsed.data.reason ?? null,
          })
          .where(eq(payments.id, row.id));
        // Credit application reversal — restore the memo.
        if (row.provider === 'CREDIT') {
          const apps = await tx
            .update(creditApplications)
            .set({ voidedAt: now, voidedById: session.appUserId })
            .where(
              and(
                eq(creditApplications.paymentId, row.id),
                sql`${creditApplications.voidedAt} IS NULL`,
              ),
            )
            .returning({ creditMemoId: creditApplications.creditMemoId });
          for (const a of apps) touchedMemoIds.push(a.creditMemoId);
        }
        await recomputeInvoicePaid(tx as unknown as Database, row.invoiceId);
        for (const memoId of touchedMemoIds) await recomputeMemoStatusInline(tx, memoId);
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { voided: true, reason: parsed.data.reason ?? null, invoiceId: row.invoiceId },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed (payment void)'));
      res.json({ ok: true });
    },
  );

  // Re-apply a manually-recorded payment across one or more invoices of the
  // same client (move or split). Pure re-application — the new allocations must
  // sum to the payment's amount (no money created). Recomputes every affected
  // invoice. Manual-only.
  const ReapplySchema = z.object({
    allocations: z
      .array(z.object({ invoiceId: z.string().uuid(), amountCents: z.number().int().positive() }))
      .min(1)
      .max(50),
  });
  router.post(
    '/:id/reapply',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      const parsed = ReapplySchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'invalid_payload' });
      if (!deps.db) return void res.status(503).json({ error: 'db_unavailable' });
      const [row] = await deps.db
        .select({
          id: payments.id,
          provider: payments.provider,
          voidedAt: payments.voidedAt,
          status: payments.status,
          amountCents: payments.amountCents,
          receiptId: payments.receiptId,
          channel: payments.channel,
          receivedAt: payments.receivedAt,
          invoiceId: payments.invoiceId,
          clientId: invoices.clientId,
          firmId: invoices.firmId,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(and(eq(payments.id, req.params['id']!), eq(invoices.firmId, session.firmId)))
        .limit(1);
      if (!row) return void res.status(404).json({ error: 'not_found' });
      if (row.provider !== 'MANUAL')
        return void res.status(409).json({ error: 'not_reapplicable_provider' });
      if (row.voidedAt) return void res.status(409).json({ error: 'payment_voided' });
      const allocs = parsed.data.allocations;
      const sum = allocs.reduce((s, a) => s + a.amountCents, 0);
      if (sum !== Number(row.amountCents)) {
        return void res
          .status(400)
          .json({ error: 'allocation_sum_mismatch', expected: Number(row.amountCents), got: sum });
      }
      // All target invoices must belong to the same client + firm.
      const ids = allocs.map((a) => a.invoiceId);
      const targets = await deps.db
        .select({ id: invoices.id, clientId: invoices.clientId })
        .from(invoices)
        .where(and(eq(invoices.firmId, session.firmId), inArray(invoices.id, ids)));
      if (targets.length !== new Set(ids).size) {
        return void res.status(404).json({ error: 'invoice_not_found' });
      }
      if (targets.some((t) => t.clientId !== row.clientId)) {
        return void res.status(409).json({ error: 'cross_client_reallocation' });
      }

      const affected = new Set<string>([row.invoiceId, ...ids]);
      await deps.db.transaction(async (tx) => {
        // First allocation re-uses the original row (keeps paymentId stable);
        // the rest are new rows under the same receipt.
        await tx
          .update(payments)
          .set({ invoiceId: allocs[0]!.invoiceId, amountCents: allocs[0]!.amountCents })
          .where(eq(payments.id, row.id));
        if (allocs.length > 1) {
          await tx.insert(payments).values(
            allocs.slice(1).map((a) => ({
              invoiceId: a.invoiceId,
              amountCents: a.amountCents,
              feeCents: 0,
              provider: 'MANUAL',
              channel: row.channel,
              status: 'SUCCEEDED' as const,
              receivedAt: row.receivedAt,
              receiptId: row.receiptId,
            })),
          );
        }
        for (const invId of affected) await recomputeInvoicePaid(tx as unknown as Database, invId);
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'payment',
        entityId: row.id,
        actorAppUserId: session.appUserId,
        after: { reapplied: allocs, from: row.invoiceId },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed (payment reapply)'));
      res.json({ ok: true });
    },
  );

  // Drill-in: all payment rows that share a receipt (one check → many invoices).
  router.get(
    '/receipt/:receiptId',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) return void res.json({ items: [] });
      const rows = await deps.db
        .select({
          paymentId: payments.id,
          invoiceId: payments.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          amountCents: payments.amountCents,
          status: payments.status,
          voidedAt: payments.voidedAt,
        })
        .from(payments)
        .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
        .where(
          and(
            eq(payments.receiptId, req.params['receiptId']!),
            eq(invoices.firmId, session.firmId),
          ),
        )
        .orderBy(asc(invoices.invoiceNumber));
      res.json({
        items: rows.map((r) => ({
          paymentId: r.paymentId,
          invoiceId: r.invoiceId,
          invoiceNumber: r.invoiceNumber,
          amountCents: Number(r.amountCents),
          status: r.status,
          voided: r.voidedAt != null,
        })),
      });
    },
  );

  // ----- Receipt document (print / email) ----------------------------

  async function renderReceiptDoc(
    req: Request,
    res: Response,
    format: 'html' | 'pdf',
  ): Promise<void> {
    const session = req.staffSession!;
    if (!deps.db) {
      res.status(503).send('db_unavailable');
      return;
    }
    const loaded = await loadReceiptDoc(deps.db, session.firmId, req.params['receiptId']!);
    if (!loaded) {
      res.status(404).send('not_found');
      return;
    }
    const html = renderPaymentReceiptHtml(loaded.doc);
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
      return;
    }
    try {
      const { renderHtmlToPdf } = await import('../pdf/render');
      const pdf = await renderHtmlToPdf(html);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="receipt-${loaded.doc.receiptId}.pdf"`,
      );
      res.send(pdf);
    } catch (err) {
      logger.warn(
        { err, receiptId: loaded.doc.receiptId },
        'receipt PDF render failed; serving HTML',
      );
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    }
  }

  router.get(
    '/receipt/:receiptId/print.html',
    requirePermission(deps, 'payment:read'),
    (req, res) => renderReceiptDoc(req, res, 'html'),
  );
  router.get('/receipt/:receiptId/print.pdf', requirePermission(deps, 'payment:read'), (req, res) =>
    renderReceiptDoc(req, res, 'pdf'),
  );

  // Direct-print the receipt to a Vibe Print gateway printer.
  const ReceiptPrintSchema = z.object({
    printerId: z.number().int().positive(),
    copies: z.number().int().min(1).max(20).optional(),
  });
  router.post(
    '/receipt/:receiptId/print',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      const parsed = ReceiptPrintSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const loaded = await loadReceiptDoc(deps.db, session.firmId, req.params['receiptId']!);
      if (!loaded) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      let pdf: Buffer;
      try {
        const { renderHtmlToPdf } = await import('../pdf/render');
        pdf = await renderHtmlToPdf(renderPaymentReceiptHtml(loaded.doc));
      } catch (err) {
        logger.error({ err, receiptId: loaded.doc.receiptId }, 'receipt print render failed');
        res.status(502).json({ error: 'render_failed' });
        return;
      }
      const result = await sendToPrinter({
        db: deps.db,
        firmId: session.firmId,
        appUserId: session.appUserId,
        printableType: 'payment_receipt',
        printableId: loaded.doc.receiptId,
        pdf,
        printerId: parsed.data.printerId,
        copies: parsed.data.copies ?? 1,
      });
      if (!result.ok) {
        res.status(502).json({ error: result.error });
        return;
      }
      res.json({ ok: true, jobId: result.jobId });
    },
  );

  // Email the receipt to the payer client's billing contact (falling back
  // to the primary contact). Attaches the PDF when renderable.
  router.post(
    '/receipt/:receiptId/email',
    requirePermission(deps, 'payment:write'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.status(503).json({ error: 'db_unavailable' });
        return;
      }
      if (!deps.sendStaffMail) {
        res.status(503).json({ error: 'mail_not_configured' });
        return;
      }
      const loaded = await loadReceiptDoc(deps.db, session.firmId, req.params['receiptId']!);
      if (!loaded) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      // Billing contact first, then primary.
      const [contact] = await deps.db
        .select({
          email: persons.email,
          name: persons.fullName,
          isBilling: clientContacts.isBilling,
        })
        .from(clientContacts)
        .innerJoin(persons, eq(persons.id, clientContacts.personId))
        .where(
          and(
            eq(clientContacts.clientId, loaded.payerClientId),
            or(eq(clientContacts.isBilling, true), eq(clientContacts.isPrimary, true)),
            sql`${persons.email} IS NOT NULL`,
          ),
        )
        .orderBy(desc(clientContacts.isBilling))
        .limit(1);
      if (!contact?.email) {
        res.status(422).json({ error: 'no_billing_contact_email' });
        return;
      }
      const html = renderPaymentReceiptHtml(loaded.doc);
      let attachments:
        | Array<{ filename: string; content: Buffer; contentType?: string }>
        | undefined;
      try {
        const { renderHtmlToPdf } = await import('../pdf/render');
        const pdf = await renderHtmlToPdf(html);
        attachments = [
          {
            filename: `receipt-${loaded.doc.receiptId.slice(0, 8)}.pdf`,
            content: pdf,
            contentType: 'application/pdf',
          },
        ];
      } catch (err) {
        logger.warn({ err }, 'receipt PDF for email failed; sending HTML body only');
      }
      // Multi-invoice PDF receipt — distinct from the single-invoice
      // `payment_received` confirmation template, so this keeps its own copy.
      const subject = `Payment receipt — ${loaded.doc.firmName}`;
      const body = `Thank you for your payment of ${formatMoneyCents(loaded.doc.totalCents)} received ${formatDateUS(loaded.doc.paymentDate)}. Your receipt is ${attachments ? 'attached' : 'below'}.`;
      try {
        await deps.sendStaffMail({ to: contact.email, subject, body, html, attachments });
      } catch (err) {
        logger.error({ err, receiptId: loaded.doc.receiptId }, 'receipt email send failed');
        res.status(502).json({ error: 'send_failed' });
        return;
      }
      await recordOutbound({
        db: deps.db,
        firmId: session.firmId,
        clientId: loaded.payerClientId,
        channel: 'EMAIL',
        subject,
        body,
        relatedEntityType: 'payment_receipt',
        relatedEntityId: loaded.doc.receiptId,
      }).catch(() => undefined);
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'payment_receipt',
        entityId: loaded.doc.receiptId,
        actorAppUserId: session.appUserId,
        after: { emailed: true, to: contact.email },
        ip: clientIp(req),
        userAgent: req.header('user-agent') ?? null,
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      res.json({ ok: true, to: contact.email });
    },
  );

  // Phase 22/26 — ACH returns dashboard. Lists ACH returns/disputes with the
  // NACHA classification + side-effect flags, newest first.
  router.get(
    '/ach-returns',
    requirePermission(deps, 'payment:read'),
    async (req: Request, res: Response) => {
      const session = req.staffSession!;
      if (!deps.db) {
        res.json({ items: [], summary: { count: 0, amountCents: 0 } });
        return;
      }
      const rows = await deps.db
        .select({
          id: achReturns.id,
          returnCode: achReturns.returnCode,
          category: achReturns.category,
          retriable: achReturns.retriable,
          invalidatedMandate: achReturns.invalidatedMandate,
          blockedPaymentMethod: achReturns.blockedPaymentMethod,
          amountCents: achReturns.amountCents,
          feeCents: achReturns.feeCents,
          source: achReturns.source,
          createdAt: achReturns.createdAt,
          invoiceId: achReturns.invoiceId,
          invoiceNumber: invoices.invoiceNumber,
          clientName: clients.name,
        })
        .from(achReturns)
        .leftJoin(invoices, eq(invoices.id, achReturns.invoiceId))
        .leftJoin(clients, eq(clients.id, invoices.clientId))
        .where(eq(achReturns.firmId, session.firmId))
        .orderBy(desc(achReturns.createdAt))
        .limit(1000);
      const amountCents = rows.reduce((s, r) => s + Number(r.amountCents), 0);
      res.json({ items: rows, summary: { count: rows.length, amountCents } });
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

// Recompute helpers live in ./recompute (Express-free) so the webhook +
// off-session charge path can be imported by the worker without pulling this
// Express-typed module into the worker's tsc program. Re-exported here for the
// existing import sites.
export { recomputeInvoicePaid, recomputeInvoicePaidReturnsFullyPaid };

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
