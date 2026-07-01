// SPDX-License-Identifier: Elastic-2.0
//
// Stripe webhook endpoint (Phase 14 #18). Verifies signature against
// the firm's webhook secret, dispatches charge.succeeded / charge.failed
// / charge.refunded events to the invoice + payment ledger. Idempotent
// at the (provider_charge_id, status) grain — re-deliveries are no-ops.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq, inArray, ne } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  creditMemos,
  dunningHistory,
  invoicePayLinks,
  invoices,
  paymentMethod,
  paymentReceipts,
  payments,
  printLog,
  terminalReaders,
} from '@vibe/db/schema';
import type { PaymentProvider } from '@vibe/core/payments';
import { formatMoneyCents } from '@vibe/core/invoicing';

import type { PrintQueue } from '../print-gateway/queue';

import { emitAudit } from '../auth/audit';
import { getBillingContact } from '../clients/billing-contact';
import { recordOutbound } from '../clients/communications';
import { logger } from '../logger';
import { recomputeInvoicePaid, recomputeInvoicePaidReturnsFullyPaid } from '../payments/routes';
import {
  promoteEscrowFilesForInvoice,
  revertEscrowFilesForInvoice,
  sendDeliverableUnlockedNotifications,
} from '../files/promote-on-paid';
import { publishWebhookEvent } from './publish';
import { firmScope, renderTemplate } from '../notifications/templating';
import { printNotificationChannel } from '../notifications/print-channel';

export interface StripeWebhookDeps {
  db: Database | null;
  stripe: PaymentProvider | null;
  webhookSecret: string | null;
  // Phase 14 #15 + #20 — confirmation email + dunning re-route hooks.
  sendEmail?: (args: { to: string; subject: string; body: string }) => Promise<void>;
  portalBaseUrl?: string;
  // 0186 — enqueue terminal receipt auto-print on card-present completion.
  // Injectable (default skip) so webhook tests run without Redis.
  printQueue?: PrintQueue;
}

interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      // Checkout Session total (cents). Present on checkout.session.* events.
      amount_total?: number;
      payment_intent?: string;
      metadata?: Record<string, string>;
      // ACH lifecycle (best-effort extraction; shapes vary by event type).
      failure_code?: string;
      payment_method?: string;
      payment_method_details?: { type?: string };
      reason?: string;
      last_payment_error?: {
        code?: string;
        payment_method?: { id?: string; type?: string };
      };
    };
  };
}

// ACH dispute reasons (late returns arrive as charge.dispute.created on an
// already-succeeded ACH charge). Used to distinguish ACH disputes from card
// chargebacks so we only react to the former.
const ACH_DISPUTE_REASONS = new Set([
  'insufficient_funds',
  'debit_not_authorized',
  'incorrect_account_details',
  'bank_cannot_process',
  'no_account',
  'account_closed',
  'payment_method_not_available',
]);

/**
 * Best-effort: pull an ACH return signal (method id + failure code) out of a
 * failed/disputed event. Returns null when the event isn't ACH so card flows
 * are untouched.
 */
function extractAchReturn(
  obj: StripeEvent['data']['object'],
): { stripePaymentMethodId: string | null; code: string } | null {
  const isAch =
    obj.payment_method_details?.type === 'us_bank_account' ||
    obj.last_payment_error?.payment_method?.type === 'us_bank_account';
  const code = obj.failure_code ?? obj.last_payment_error?.code ?? null;
  if (!isAch && !code) return null;
  if (!isAch) return null;
  return {
    stripePaymentMethodId: obj.last_payment_error?.payment_method?.id ?? obj.payment_method ?? null,
    code: code ?? 'OTHER',
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
      const materialized = await materializeReceiptIfPending(deps.db, intentId, deps.printQueue);
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
      // Settle under an invoice ROW LOCK so concurrent settlements on the same
      // invoice serialize: recompute paid_cents from the SUCCEEDED payment set
      // (an ABSOLUTE value, immune to the read-modify-write lost-update that a
      // `paid_cents += amount` would suffer when two different payments land on
      // one invoice at once). The conditional flip (WHERE status != SUCCEEDED)
      // additionally guarantees only ONE delivery of THIS payment runs the
      // post-settlement side effects below — idempotent on duplicate events.
      const settled = await deps.db.transaction(async (tx) => {
        const [lockedInv] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, pay.invoiceId))
          .for('update')
          .limit(1);
        const claim = await tx
          .update(payments)
          .set({ status: 'SUCCEEDED' })
          .where(and(eq(payments.id, pay.id), ne(payments.status, 'SUCCEEDED')))
          .returning({ id: payments.id });
        if (claim.length === 0) return null; // already settled by a concurrent delivery
        if (!lockedInv) return { inv: null, fullyPaid: false, newPaidCents: 0 };
        const fp = await recomputeInvoicePaidReturnsFullyPaid(tx, lockedInv.id);
        const [fresh] = await tx
          .select({ paid: invoices.paidCents })
          .from(invoices)
          .where(eq(invoices.id, lockedInv.id))
          .limit(1);
        return { inv: lockedInv, fullyPaid: fp, newPaidCents: Number(fresh?.paid ?? 0) };
      });
      if (!settled) return; // duplicate delivery — payment already settled
      const inv = settled.inv;
      const fullyPaid = settled.fullyPaid;
      const newPaidCents = settled.newPaidCents;

      await emitAudit(deps.db, {
        action: 'PAYMENT',
        entityType: 'invoice',
        entityId: pay.invoiceId,
        // Webhook events have no user/portal/token actor. Identifiable
        // by entity_type + after_json.providerChargeId.
        after: { providerChargeId: chargeId, status: 'SUCCEEDED' },
      }).catch((err: unknown) => logger.error({ err }, 'audit emit failed'));
      // Dispatch outbound events using the recomputed balance.
      if (inv) {
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
              const fallbackSubject = `Payment received — ${inv.invoiceNumber}`;
              const fallbackBody = [
                `Hi ${client.name},`,
                ``,
                `We've received your payment of ${formatMoneyCents(pay.amountCents)} for invoice ${inv.invoiceNumber}.`,
                fullyPaid
                  ? `This invoice is now PAID. Thank you!`
                  : `Remaining balance: ${formatMoneyCents(inv.totalCents - newPaidCents)}.`,
                link ? `\nView receipt: ${link}` : '',
              ].join('\n');
              const rendered = await renderTemplate({
                db: deps.db,
                firmId: inv.firmId,
                kind: 'payment_received',
                channel: 'EMAIL',
                fallback: { subject: fallbackSubject, body: fallbackBody },
                context: {
                  client: { name: client.name },
                  firm: await firmScope(deps.db, inv.firmId),
                  invoice: {
                    number: inv.invoiceNumber,
                    balance: formatMoneyCents(inv.totalCents - newPaidCents),
                    portal_url: link,
                  },
                },
              });
              const subject = rendered.subject ?? fallbackSubject;
              const body = rendered.body;
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
        // PRINT channel (0188) — auto-print a payment-received copy. Runs
        // independently of the email branch (a firm may use PRINT-only
        // receipts, or a client may have no billing email). Best-effort.
        {
          const link = deps.portalBaseUrl ? `${deps.portalBaseUrl}/invoices/${inv.id}` : '';
          const [printClient] = await deps.db
            .select({ name: clients.name })
            .from(clients)
            .where(eq(clients.id, inv.clientId))
            .limit(1);
          await printNotificationChannel({
            db: deps.db,
            firmId: inv.firmId,
            kind: 'payment_received',
            clientId: inv.clientId,
            printableId: inv.id,
            context: {
              client: { name: printClient?.name ?? '' },
              firm: await firmScope(deps.db, inv.firmId),
              invoice: {
                number: inv.invoiceNumber,
                balance: formatMoneyCents(inv.totalCents - newPaidCents),
                portal_url: link,
              },
            },
          }).catch((err) =>
            logger.warn({ err, invoiceId: inv.id }, 'payment print channel failed'),
          );
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
              const r = await activateRetainerFromPaidInvoice(deps.db!, inv.id, {
                sendEmail: deps.sendEmail,
              });
              if (r.kind === 'error') {
                logger.error({ invoiceId: inv.id, reason: r.reason }, 'retainer activation error');
              }
            } catch (err) {
              logger.error({ err, invoiceId: inv.id }, 'retainer activation threw');
            }
          } else if (inv.retainerId) {
            // 0091 — firm-initiated retainer bill (no offer).
            try {
              const { activateRetainerFromDirectPaidInvoice } =
                await import('../retainers/activation');
              const r = await activateRetainerFromDirectPaidInvoice(deps.db!, inv.id, {
                sendEmail: deps.sendEmail,
              });
              if (r.kind === 'error') {
                logger.error(
                  { invoiceId: inv.id, reason: r.reason },
                  'retainer direct activation error',
                );
              }
            } catch (err) {
              logger.error({ err, invoiceId: inv.id }, 'retainer direct activation threw');
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
        }).catch((err: unknown) =>
          // PAYMENT audit is non-repudiable — don't swallow silently.
          logger.error(
            { err, receiptId: pendingReceipt.id },
            'audit emit failed (payment_receipt FAILED)',
          ),
        );
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
        // Phase 22 — ACH return: record + invalidate mandate / block PM / pause
        // schedules per the NACHA classification. No-op for card failures.
        const ach = extractAchReturn(event.data.object);
        if (ach) {
          const { recordAchReturnAndReact } = await import('../payments/ach-lifecycle');
          await recordAchReturnAndReact(deps.db, {
            firmId: inv.firmId,
            returnCode: ach.code,
            paymentId: pay.id,
            invoiceId: pay.invoiceId,
            stripePaymentIntentId: intentId,
            stripeChargeId: chargeId,
            stripePaymentMethodId: ach.stripePaymentMethodId,
            amountCents: Number(pay.amountCents),
            source: 'failure',
          }).catch((err: unknown) => logger.error({ err }, 'ach return handling failed'));
        }
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
            }).catch((err: unknown) =>
              logger.error({ err, payId: pay.id }, 'audit emit failed (credit_auto_refund_excess)'),
            );
          } catch (err) {
            logger.warn({ err, payId: pay.id }, 'refund-excess credit creation failed');
          }
        }
      }

      // Phase 22 — late ACH return (final, uncontestable). Only on dispute
      // creation, and only for ACH dispute reasons (skip card chargebacks).
      const reason = event.data.object.reason;
      if (
        event.type === 'charge.dispute.created' &&
        inv &&
        reason &&
        ACH_DISPUTE_REASONS.has(reason)
      ) {
        let stripePm: string | null = null;
        if (pay.paymentMethodId) {
          const [pm] = await deps.db
            .select({ token: paymentMethod.providerToken })
            .from(paymentMethod)
            .where(eq(paymentMethod.id, pay.paymentMethodId))
            .limit(1);
          stripePm = pm?.token ?? null;
        }
        const { recordAchReturnAndReact } = await import('../payments/ach-lifecycle');
        await recordAchReturnAndReact(deps.db, {
          firmId: inv.firmId,
          returnCode: reason,
          paymentId: pay.id,
          invoiceId: pay.invoiceId,
          stripeChargeId: chargeId,
          stripePaymentIntentId: intentId,
          stripePaymentMethodId: stripePm,
          amountCents: Number(refundedAmount),
          source: 'dispute',
        }).catch((err: unknown) => logger.error({ err }, 'ach dispute handling failed'));
      }
      return;
    }
    case 'checkout.session.completed': {
      // 0181 — pay-by-link settlement. A hosted Checkout Session the client
      // opened from the no-login /pay/:token page has completed. We do NOT
      // trust the browser redirect; THIS event is the proof of payment.
      const meta = event.data.object.metadata ?? {};
      const tokenHash = meta['pay_link_token_hash'];
      if (!tokenHash) return; // not a pay-link checkout
      // The session's PaymentIntent is the ledger key; chargeId here is the
      // Checkout Session id (cs_…), which we stash for reconciliation.
      const piId = event.data.object.payment_intent ?? chargeId;

      // Settle atomically under a row lock on the pay-link. The lock + the
      // link.status PAID gate make duplicate deliveries of this event fully
      // idempotent: the first delivery marks the link PAID inside the lock,
      // so any later delivery reads PAID and does NOT re-insert or re-dispatch.
      const settle = await deps.db.transaction(async (tx) => {
        const [link] = await tx
          .select()
          .from(invoicePayLinks)
          .where(eq(invoicePayLinks.tokenHash, tokenHash))
          .for('update')
          .limit(1);
        if (!link || link.status === 'PAID') return { proceed: false as const };

        const [existing] = await tx
          .select({ status: payments.status })
          .from(payments)
          .where(eq(payments.providerChargeId, piId))
          .limit(1);

        if (!existing) {
          // Clamp to the invoice's CURRENT open balance — multiple active
          // links + portal pay + staff receive can settle the same invoice
          // between checkout-open and here. Excess (overpayment) is dropped
          // from the invoice ledger, mirroring the staff-receipt path; the
          // firm's Stripe reconciliation surfaces any surplus.
          const [inv] = await tx
            .select({
              total: invoices.totalCents,
              paid: invoices.paidCents,
              clientId: invoices.clientId,
              firmId: invoices.firmId,
            })
            .from(invoices)
            .where(eq(invoices.id, link.invoiceId))
            .limit(1);
          const open = inv ? Number(inv.total) - Number(inv.paid) : 0;
          const requested = event.data.object.amount_total ?? event.data.object.amount ?? 0;
          const amount = Math.max(0, Math.min(requested, open));
          if (amount > 0) {
            await tx.insert(payments).values({
              invoiceId: link.invoiceId,
              amountCents: amount,
              feeCents: 0,
              provider: 'STRIPE',
              providerChargeId: piId,
              status: 'PENDING',
              receivedAt: new Date(),
            });
          }
          // Stripe already CAPTURED `requested`; if we applied less than that
          // to the invoice (it was paid down / fully paid concurrently), bank
          // the surplus as an OPEN client credit so the money is tracked and
          // refundable — never silently dropped.
          const excessCents = requested - amount;
          if (excessCents > 0 && inv) {
            await tx.insert(creditMemos).values({
              firmId: inv.firmId,
              clientId: inv.clientId,
              issuedDate: new Date().toISOString().slice(0, 10),
              originalAmountCents: excessCents,
              source: 'OVERPAYMENT',
              reference: `Pay-link overpayment (Stripe session ${chargeId})`,
              status: 'OPEN',
              sourcePaymentId: null,
            });
          }
          // amount === 0 → invoice already settled; just mark the link PAID.
          await tx
            .update(invoicePayLinks)
            .set({ status: 'PAID', paidAt: new Date(), stripeSessionId: chargeId })
            .where(eq(invoicePayLinks.id, link.id));
          return { proceed: amount > 0 ? (true as const) : (false as const) };
        }

        // A payment row already exists for this PI (PENDING from an earlier
        // partial delivery, or SUCCEEDED). Mark the link PAID; let the
        // succeeded path finalize the ledger (idempotent on payment.status).
        await tx
          .update(invoicePayLinks)
          .set({ status: 'PAID', paidAt: new Date(), stripeSessionId: chargeId })
          .where(eq(invoicePayLinks.id, link.id));
        return { proceed: existing.status !== 'SUCCEEDED' };
      });

      // Delegate to the succeeded path OUTSIDE the lock: it finds the pending
      // payment by provider_charge_id, flips it to SUCCEEDED, updates the
      // invoice, and runs every paid side-effect (escrow promote, confirmation
      // email, retainer activation, outbound webhooks). A real
      // payment_intent.succeeded for the same PI arriving later finds it
      // already SUCCEEDED and no-ops.
      if (settle.proceed) {
        await dispatch(deps, {
          id: event.id,
          type: 'payment_intent.succeeded',
          data: { object: { id: piId, payment_intent: piId, metadata: meta } },
        });
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
// Exported so the off-session charge service can settle synchronously when a
// card charge returns 'succeeded' immediately (the webhook is the backstop;
// this is idempotent — a re-run finds the receipt already SUCCEEDED → no-op).
export async function materializeReceiptIfPending(
  db: Database,
  intentId: string,
  printQueue?: PrintQueue,
): Promise<boolean> {
  const [receipt] = await db
    .select()
    .from(paymentReceipts)
    .where(eq(paymentReceipts.providerChargeId, intentId))
    .limit(1);
  if (!receipt) return false;
  if (receipt.status === 'SUCCEEDED') {
    // Re-delivery. The receipt was already materialized, but a crash between
    // the commit and the enqueue on the original delivery could have left the
    // auto-print un-enqueued — so we (idempotently) ensure it here too. The
    // deterministic queue jobId + gateway idempotency key prevent any double
    // physical print.
    await enqueueTerminalReceiptPrint(db, receipt, printQueue);
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

  // 0186 — auto-print the receipt to the terminal's configured printer.
  // Idempotent (deterministic jobId + gateway idempotency key), so it is also
  // safe to re-run on webhook re-delivery (see the SUCCEEDED branch above).
  await enqueueTerminalReceiptPrint(db, receipt, printQueue);

  await emitAudit(db, {
    action: 'PAYMENT',
    entityType: 'payment_receipt',
    entityId: receipt.id,
    after: {
      kind: 'receive_materialized',
      providerChargeId: intentId,
      allocationCount: allocations.length,
    },
  }).catch((err: unknown) =>
    logger.error({ err, receiptId: receipt.id }, 'audit emit failed (receive_materialized)'),
  );

  return true;
}

/** 0186 — enqueue the terminal receipt auto-print for a SUCCEEDED receipt.
 *  Idempotent: the queue uses a deterministic jobId and the worker sends with
 *  a `termreceipt:` gateway idempotency key, so calling this on both the fresh
 *  transition and any webhook re-delivery prints at most once. */
async function enqueueTerminalReceiptPrint(
  db: Database,
  receipt: { id: string; firmId: string; terminalReaderId: string | null },
  printQueue?: PrintQueue,
): Promise<void> {
  if (!printQueue || !receipt.terminalReaderId) return;
  const [reader] = await db
    .select({ printerId: terminalReaders.printerId, autoPrint: terminalReaders.autoPrintReceipt })
    .from(terminalReaders)
    .where(eq(terminalReaders.id, receipt.terminalReaderId))
    .limit(1);
  if (!reader?.autoPrint) return;
  if (reader.printerId != null) {
    await printQueue
      .terminalReceipt({ receiptId: receipt.id, printerId: reader.printerId })
      .catch((err: unknown) =>
        logger.error({ err, receiptId: receipt.id }, 'terminal receipt enqueue failed'),
      );
  } else {
    // Auto-print on but no printer assigned → skip + log (don't print to the
    // wrong location).
    await db
      .insert(printLog)
      .values({
        firmId: receipt.firmId,
        appUserId: null,
        printableType: 'payment_receipt',
        printableId: receipt.id,
        printerId: 0,
        status: 'FAILED',
        error: 'no_printer_assigned',
      })
      .catch(() => undefined);
  }
}
