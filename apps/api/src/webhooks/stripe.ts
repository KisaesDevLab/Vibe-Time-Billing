// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stripe webhook endpoint (Phase 14 #18). Verifies signature against
// the firm's webhook secret, dispatches charge.succeeded / charge.failed
// / charge.refunded events to the invoice + payment ledger. Idempotent
// at the (provider_charge_id, status) grain — re-deliveries are no-ops.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  creditMemos,
  dunningHistory,
  invoices,
  paymentReceipts,
  payments,
} from '@vibe/db/schema';
import type { PaymentProvider } from '@vibe/core/payments';

import { emitAudit } from '../auth/audit';
import { getBillingContact } from '../clients/billing-contact';
import { recordOutbound } from '../clients/communications';
import { logger } from '../logger';
import { recomputeInvoicePaid } from '../payments/routes';
import {
  promoteEscrowFilesForInvoice,
  revertEscrowFilesForInvoice,
  sendDeliverableUnlockedNotifications,
} from '../files/promote-on-paid';
import { publishWebhookEvent } from './publish';

export interface StripeWebhookDeps {
  db: Database | null;
  stripe: PaymentProvider | null;
  webhookSecret: string | null;
  // Phase 14 #15 + #20 — confirmation email + dunning re-route hooks.
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  portalBaseUrl?: string;
}

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      payment_intent?: string;
      metadata?: Record<string, string>;
    };
  };
}

export function createStripeWebhookRouter(deps: StripeWebhookDeps): Router {
  const router = express.Router();
  // Stripe needs the raw body to verify the signature.
  router.use(express.raw({ type: 'application/json', limit: '1mb' }));

  router.post('/', async (req: Request, res: Response) => {
    if (!deps.stripe || !deps.webhookSecret) {
      res.status(503).json({ error: 'stripe_not_configured' });
      return;
    }
    const signature = req.header('stripe-signature');
    if (!signature) {
      res.status(400).json({ error: 'missing_signature' });
      return;
    }
    const payload = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body);
    const ok = deps.stripe.verifyWebhookSignature({
      payload,
      signature,
      secret: deps.webhookSecret,
    });
    if (!ok) {
      res.status(401).json({ error: 'invalid_signature' });
      return;
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(payload) as StripeEvent;
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }

    try {
      await dispatch(deps, event);
    } catch (err) {
      logger.error({ err, eventId: event.id, type: event.type }, 'stripe webhook dispatch failed');
      // Stripe will retry on 5xx; if the failure is a bug, this gives us
      // visibility while still letting Stripe back off.
      res.status(500).json({ error: 'dispatch_failed' });
      return;
    }
    res.json({ received: true });
  });

  return router;
}

async function dispatch(deps: StripeWebhookDeps, event: StripeEvent): Promise<void> {
  if (!deps.db) return;
  const chargeId = event.data.object.id;
  // payment_intent id from either intent-level (id) or charge-level
  // (payment_intent) events. Receipts store payment_intent.id.
  const intentId = event.data.object.payment_intent ?? chargeId;
  switch (event.type) {
    case 'charge.succeeded':
    case 'payment_intent.succeeded': {
      // 0055 — first, check whether this matches a PENDING staff
      // Receive Payment receipt. If so, materialize the payment rows
      // from the stashed allocations. This is the single source of
      // truth for CHARGE-mode receipts; the frontend just polls
      // /payments/receive/:id until status leaves PENDING.
      const materialized = await materializeReceiptIfPending(deps.db, intentId);
      if (materialized) return;

      // Find the payment row by provider_charge_id and mark succeeded.
      const [pay] = await deps.db
        .select()
        .from(payments)
        .where(eq(payments.providerChargeId, chargeId))
        .limit(1);
      if (!pay) {
        // Charge initiated externally (e.g. Stripe dashboard) — skip
        // silently; the firm's reconciliation report flags it.
        return;
      }
      if (pay.status === 'SUCCEEDED') return;
      await deps.db.update(payments).set({ status: 'SUCCEEDED' }).where(eq(payments.id, pay.id));
      // Update the invoice
      const [inv] = await deps.db
        .select()
        .from(invoices)
        .where(eq(invoices.id, pay.invoiceId))
        .limit(1);
      if (inv) {
        const newPaid = inv.paidCents + pay.amountCents;
        const newStatus = newPaid >= inv.totalCents ? 'PAID' : 'PARTIALLY_PAID';
        await deps.db
          .update(invoices)
          .set({
            paidCents: newPaid,
            status: newStatus,
            paidAt: newStatus === 'PAID' ? new Date() : null,
          })
          .where(eq(invoices.id, inv.id));
      }
      await emitAudit(deps.db, {
        action: 'PAYMENT',
        entityType: 'invoice',
        entityId: pay.invoiceId,
        // Webhook events have no user/portal/token actor. Identifiable
        // by entity_type + after_json.providerChargeId.
        after: { providerChargeId: chargeId, status: 'SUCCEEDED' },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      // Dispatch outbound events. We re-read the invoice to pick the
      // right "paid" vs "received" event depending on whether it cleared
      // the full balance.
      if (inv) {
        const fullyPaid = inv.paidCents + pay.amountCents >= inv.totalCents;
        await publishWebhookEvent(deps.db, inv.firmId, 'payment.received', {
          invoiceId: pay.invoiceId,
          paymentId: pay.id,
          amountCents: pay.amountCents,
        }).catch((err: unknown) => logger.error({ err }, 'webhook publish failed'));
        // Phase 14 #15 — payment confirmation email to the client.
        if (deps.sendEmail) {
          try {
            const [client] = await deps.db
              .select({ name: clients.name })
              .from(clients)
              .where(eq(clients.id, inv.clientId))
              .limit(1);
            // v2 0027 — billing email lives on client_contact.
            const billingContact = await getBillingContact(deps.db, inv.clientId);
            if (client && billingContact?.email) {
              const link = deps.portalBaseUrl ? `${deps.portalBaseUrl}/invoices/${inv.id}` : '';
              const subject = `Payment received — ${inv.invoiceNumber}`;
              const body = [
                `Hi ${client.name},`,
                ``,
                `We've received your payment of $${(pay.amountCents / 100).toFixed(2)} for invoice ${inv.invoiceNumber}.`,
                fullyPaid
                  ? `This invoice is now PAID. Thank you!`
                  : `Remaining balance: $${((inv.totalCents - inv.paidCents - pay.amountCents) / 100).toFixed(2)}.`,
                link ? `\nView receipt: ${link}` : '',
              ].join('\n');
              await deps.sendEmail({ to: billingContact.email, subject, body });
              // v2 Sprint C — auto-record outbound in client timeline.
              await recordOutbound({
                db: deps.db,
                firmId: inv.firmId,
                clientId: inv.clientId,
                channel: 'EMAIL',
                subject,
                body,
                relatedEntityType: 'invoice',
                relatedEntityId: inv.id,
              }).catch((err) => logger.warn({ err }, 'comms record failed'));
            }
          } catch (err) {
            logger.warn({ err, invoiceId: inv.id }, 'payment confirmation email failed');
          }
        }
        if (fullyPaid) {
          await publishWebhookEvent(deps.db, inv.firmId, 'invoice.paid', {
            invoiceId: pay.invoiceId,
            totalCents: inv.totalCents,
          }).catch((err: unknown) => logger.error({ err }, 'webhook publish failed'));
          // Stage 3 — flip escrow files gated by this invoice to
          // client_visible. Best-effort: log + continue on failure.
          try {
            const promoted = await promoteEscrowFilesForInvoice(deps.db!, {
              firmId: inv.firmId,
              invoiceId: inv.id,
            });
            // P3.3 — fire deliverable-unlocked email to portal
            // identities on this client. Post-commit; failures swallow.
            if (promoted.length > 0) {
              await sendDeliverableUnlockedNotifications(deps.db!, {
                invoiceId: inv.id,
                promotedFileCount: promoted.length,
                portalBaseUrl: deps.portalBaseUrl,
                sendEmail: deps.sendEmail,
              }).catch((err) =>
                logger.error({ err, invoiceId: inv.id }, 'deliverable-unlocked dispatch failed'),
              );
            }
          } catch (err) {
            logger.error({ err, invoiceId: inv.id }, 'escrow promote failed');
          }
          // R3 — retainer activation. If this invoice carries
          // retainer_offer_id, run the activation handler (idempotent
          // against Stripe retries by SELECT FOR UPDATE on the offer).
          if (inv.retainerOfferId) {
            try {
              const { activateRetainerFromPaidInvoice } = await import('../retainers/activation');
              const r = await activateRetainerFromPaidInvoice(deps.db!, inv.id);
              if (r.kind === 'error') {
                logger.error({ invoiceId: inv.id, reason: r.reason }, 'retainer activation error');
              }
            } catch (err) {
              logger.error({ err, invoiceId: inv.id }, 'retainer activation threw');
            }
          }
          // Phase 14 #14 — pay-to-unlock signal. If this invoice gated
          // attachment access and was the last unpaid pay-to-unlock
          // blocker for its client, publish client.unlocked so portal
          // and integrations can flip the gate without polling.
          if (inv.payToUnlockAttachments) {
            const stillBlocking = await deps.db
              .select({ id: invoices.id, status: invoices.status })
              .from(invoices)
              .where(
                and(eq(invoices.clientId, inv.clientId), eq(invoices.payToUnlockAttachments, true)),
              )
              .then((rows) =>
                rows.filter((r) => r.id !== inv.id && r.status !== 'PAID' && r.status !== 'VOIDED'),
              );
            if (stillBlocking.length === 0) {
              await publishWebhookEvent(deps.db, inv.firmId, 'client.unlocked', {
                clientId: inv.clientId,
                clearedInvoiceId: inv.id,
              }).catch((err: unknown) => logger.error({ err }, 'webhook publish failed'));
            }
          }
        }
      }
      return;
    }
    case 'charge.failed':
    case 'payment_intent.payment_failed': {
      // 0055 — flip any matching PENDING receipt to FAILED first so the
      // staff polling endpoint reports the result. No payment rows are
      // written for a failed CHARGE-mode attempt.
      const [pendingReceipt] = await deps.db
        .select({ id: paymentReceipts.id })
        .from(paymentReceipts)
        .where(
          and(
            eq(paymentReceipts.providerChargeId, intentId),
            eq(paymentReceipts.status, 'PENDING'),
          ),
        )
        .limit(1);
      if (pendingReceipt) {
        await deps.db
          .update(paymentReceipts)
          .set({ status: 'FAILED', updatedAt: new Date() })
          .where(eq(paymentReceipts.id, pendingReceipt.id));
        await emitAudit(deps.db, {
          action: 'PAYMENT',
          entityType: 'payment_receipt',
          entityId: pendingReceipt.id,
          after: { providerChargeId: intentId, status: 'FAILED' },
        }).catch(() => undefined);
        return;
      }
      const [pay] = await deps.db
        .select()
        .from(payments)
        .where(eq(payments.providerChargeId, chargeId))
        .limit(1);
      if (!pay) return;
      await deps.db.update(payments).set({ status: 'FAILED' }).where(eq(payments.id, pay.id));
      // Phase 14 #20 — dunning re-route on failed payment. Clear the
      // dunning_history for this invoice so the next sweep treats it
      // as a fresh overdue and restarts the friendly-reminder cycle.
      // The unique index on (invoice_id, step_kind) was the suppression
      // gate; deletion lifts it.
      await deps.db
        .delete(dunningHistory)
        .where(eq(dunningHistory.invoiceId, pay.invoiceId))
        .catch((err: unknown) =>
          logger.warn({ err, invoiceId: pay.invoiceId }, 'dunning re-route reset failed'),
        );
      const [inv] = await deps.db
        .select({ firmId: invoices.firmId })
        .from(invoices)
        .where(eq(invoices.id, pay.invoiceId))
        .limit(1);
      if (inv) {
        await publishWebhookEvent(deps.db, inv.firmId, 'payment.failed', {
          invoiceId: pay.invoiceId,
          paymentId: pay.id,
        }).catch((err: unknown) => logger.error({ err }, 'webhook publish failed'));
      }
      return;
    }
    case 'charge.refunded':
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const [pay] = await deps.db
        .select()
        .from(payments)
        .where(eq(payments.providerChargeId, chargeId))
        .limit(1);
      if (!pay) return;
      const refundedAmount = event.data.object.amount ?? pay.amountCents;
      await deps.db
        .update(payments)
        .set({
          status: 'REFUNDED',
          refundedAt: new Date(),
          refundedAmountCents: refundedAmount,
        })
        .where(eq(payments.id, pay.id));

      // 0056 — REFUND_EXCESS auto-credit. If the refund is greater than
      // what was needed to bring the invoice back to a non-negative
      // open balance (i.e., other payments had already covered some of
      // this invoice), the surplus becomes a credit on the client's
      // account so the firm doesn't owe untracked money.
      const [inv] = await deps.db
        .select({
          id: invoices.id,
          firmId: invoices.firmId,
          clientId: invoices.clientId,
          totalCents: invoices.totalCents,
          paidCents: invoices.paidCents,
        })
        .from(invoices)
        .where(eq(invoices.id, pay.invoiceId))
        .limit(1);
      if (inv) {
        // Stage 3 — revert any escrow files previously auto-promoted by
        // this invoice's payment. Best-effort.
        try {
          await revertEscrowFilesForInvoice(deps.db, {
            firmId: inv.firmId,
            invoiceId: inv.id,
          });
        } catch (err) {
          logger.error({ err, invoiceId: inv.id }, 'escrow revert failed');
        }
        // After this refund clears, the invoice's effective recoverable
        // need = totalCents - (otherPaid). If the refund > what this
        // payment had actually applied to the invoice's needed amount,
        // the excess is credit. Simple definition: if (paidCents - refundedAmount) < 0,
        // those negative cents are the credit.
        const postRefundPaid = Number(inv.paidCents) - Number(refundedAmount);
        const excess = postRefundPaid < 0 ? -postRefundPaid : 0;
        if (excess > 0) {
          try {
            const today = new Date().toISOString().slice(0, 10);
            await deps.db.insert(creditMemos).values({
              firmId: inv.firmId,
              clientId: inv.clientId,
              issuedDate: today,
              originalAmountCents: excess,
              source: 'REFUND_EXCESS',
              reference: `Refund excess from payment ${pay.id}`,
              status: 'OPEN',
              sourcePaymentId: pay.id,
            });
            await emitAudit(deps.db, {
              action: 'PAYMENT',
              entityType: 'credit_memo',
              after: {
                kind: 'credit_auto_refund_excess',
                clientId: inv.clientId,
                amountCents: excess,
                sourcePaymentId: pay.id,
              },
            }).catch(() => undefined);
          } catch (err) {
            logger.warn({ err, payId: pay.id }, 'refund-excess credit creation failed');
          }
        }
      }
      return;
    }
    default:
      logger.debug({ type: event.type }, 'unhandled stripe event');
  }
}

/**
 * 0055 — when a Stripe payment_intent.succeeded event arrives for a
 * staff Receive Payment receipt that is still PENDING, materialize the
 * N child payment rows from the receipt's stashed allocations.
 *
 * Returns true when a receipt was processed (whether materialized or
 * already SUCCEEDED — both cases mean "this id belongs to a receipt, do
 * NOT fall through to the legacy per-payment branch").
 *
 * Idempotent on (provider_charge_id, status='SUCCEEDED'): a re-delivery
 * finds the receipt already SUCCEEDED and returns without re-writing.
 */
async function materializeReceiptIfPending(db: Database, intentId: string): Promise<boolean> {
  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.providerChargeId, intentId))
    .limit(1);
  if (!receipt) return false;
  if (receipt.status === 'SUCCEEDED') {
    // Re-delivery; nothing to do but signal that we owned the event.
    return true;
  }
  if (receipt.status !== 'PENDING') return true;
  const allocations = (receipt.allocationsPending ?? []) as {
    invoiceId: string;
    amountCents: number;
  }[];
  if (allocations.length === 0) {
    await db
      .update(paymentReceipts)
      .set({ status: 'FAILED', updatedAt: new Date() })
      .where(eq(paymentReceipts.id, receipt.id));
    logger.warn({ receiptId: receipt.id }, 'pending receipt had no allocations');
    return true;
  }

  await db.transaction(async (tx) => {
    // Lock allocation invoices in firm scope, then re-validate balances.
    const locked = await tx
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
            allocations.map((a) => a.invoiceId),
          ),
          eq(invoices.firmId, receipt.firmId),
        ),
      )
      .for('update');
    const lockedById = new Map(locked.map((i) => [i.id, i]));
    const receivedAt = new Date();
    for (const a of allocations) {
      const inv = lockedById.get(a.invoiceId);
      if (!inv) {
        // Invoice disappeared (voided?) between intent and confirmation —
        // skip this row; the receipt total may not match the sum applied,
        // which the reconciliation report will surface.
        continue;
      }
      const open = Number(inv.totalCents) - Number(inv.paidCents);
      // If someone else already paid the invoice down (e.g., portal pay
      // between intent and webhook), apply only what fits. Excess gets
      // dropped — better than violating the invoice CHECK constraint.
      const apply = Math.min(a.amountCents, open);
      if (apply <= 0) continue;
      await tx.insert(payments).values({
        invoiceId: inv.id,
        amountCents: apply,
        feeCents: 0,
        provider: 'STRIPE',
        providerChargeId: intentId,
        status: 'SUCCEEDED',
        receivedAt,
        receiptId: receipt.id,
      });
      await recomputeInvoicePaid(tx, inv.id);
    }
    await tx
      .update(paymentReceipts)
      .set({
        status: 'SUCCEEDED',
        allocationsPending: null,
        updatedAt: new Date(),
      })
      .where(eq(paymentReceipts.id, receipt.id));
  });

  await emitAudit(db, {
    action: 'PAYMENT',
    entityType: 'payment_receipt',
    entityId: receipt.id,
    after: {
      kind: 'receive_materialized',
      providerChargeId: intentId,
      allocationCount: allocations.length,
    },
  }).catch(() => undefined);

  return true;
}
