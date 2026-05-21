// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Stripe webhook endpoint (Phase 14 #18). Verifies signature against
// the firm's webhook secret, dispatches charge.succeeded / charge.failed
// / charge.refunded events to the invoice + payment ledger. Idempotent
// at the (provider_charge_id, status) grain — re-deliveries are no-ops.

import express, { type Request, type Response, type Router } from 'express';
import { and, eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { clients, dunningHistory, invoices, payments } from '@vibe/db/schema';
import type { PaymentProvider } from '@vibe/core/payments';

import { emitAudit } from '../auth/audit';
import { logger } from '../logger';
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
  switch (event.type) {
    case 'charge.succeeded':
    case 'payment_intent.succeeded': {
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
        // Webhook events have no user/portal actor; flagged with a
        // null token id but identifiable by event metadata.
        actorMcpTokenId: 'stripe-webhook',
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
              .select({
                name: clients.name,
                email: clients.billingContactEmail,
              })
              .from(clients)
              .where(eq(clients.id, inv.clientId))
              .limit(1);
            if (client?.email) {
              const link = deps.portalBaseUrl ? `${deps.portalBaseUrl}/invoices/${inv.id}` : '';
              await deps.sendEmail({
                to: client.email,
                subject: `Payment received — ${inv.invoiceNumber}`,
                body: [
                  `Hi ${client.name},`,
                  ``,
                  `We've received your payment of $${(pay.amountCents / 100).toFixed(2)} for invoice ${inv.invoiceNumber}.`,
                  fullyPaid
                    ? `This invoice is now PAID. Thank you!`
                    : `Remaining balance: $${((inv.totalCents - inv.paidCents - pay.amountCents) / 100).toFixed(2)}.`,
                  link ? `\nView receipt: ${link}` : '',
                ].join('\n'),
              });
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
      await deps.db
        .update(payments)
        .set({
          status: 'REFUNDED',
          refundedAt: new Date(),
          refundedAmountCents: event.data.object.amount ?? pay.amountCents,
        })
        .where(eq(payments.id, pay.id));
      return;
    }
    default:
      logger.debug({ type: event.type }, 'unhandled stripe event');
  }
}
