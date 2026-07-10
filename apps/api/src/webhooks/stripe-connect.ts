// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P12 — Stripe Connect webhook receiver.
//
// Mounted at /api/webhooks/stripe-connect. Stripe delivers events about
// connected accounts here using the platform's webhook secret (distinct
// from the per-firm Stripe-direct webhook handled by ../webhooks/stripe.ts).
//
// Flow:
//   1. Verify signature against STRIPE_CONNECT_WEBHOOK_SECRET. Reject 401
//      on mismatch — never trust unsigned.
//   2. Parse the event body. Reject 400 on JSON parse error.
//   3. INSERT into webhook_events keyed on stripe_event_id. On unique-
//      violation, the event is a re-delivery — return 200 OK without
//      reprocessing (idempotency invariant).
//   4. Dispatch to a handler based on event.type. Handlers update the
//      Stripe mapping tables (stripe_subscriptions, stripe_invoices,
//      payment_mandates, firm_settings_proposals).
//   5. On success, stamp processed_at + state=PROCESSED. On failure,
//      stamp state=FAILED + last_error and re-throw so Stripe retries
//      via 5xx.
//
// Handlers covered (addendum §P12):
//   invoice.paid / payment_failed / finalized
//   customer.subscription.created / updated / deleted
//   payment_method.attached / detached / automatically_updated
//   mandate.updated
//   payout.paid / failed
//   charge.dispute.created
//   account.updated
//   setup_intent.succeeded
//
// Unhandled types are logged + marked IGNORED so we don't crash if
// Stripe adds new event types we haven't wired yet.

import express, { type Request, type Response, type Router } from 'express';
import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  firmSettingsProposals,
  paymentMandates,
  stripeInvoices,
  stripeSubscriptions,
  webhookEvents,
} from '@vibe/db/schema';
import type { PaymentProvider } from '@vibe/core/payments';

import { logger } from '../logger';
import { pgErrorCode } from '../db-error';

export interface StripeConnectWebhookDeps {
  db: Database | null;
  stripe: PaymentProvider | null;
  webhookSecret: string | null;
}

interface StripeEvent {
  id: string;
  type: string;
  account?: string; // The connected account id (acct_…) Stripe attaches.
  data: { object: Record<string, unknown> };
  livemode?: boolean;
}

export function createStripeConnectWebhookRouter(deps: StripeConnectWebhookDeps): Router {
  const router = express.Router();
  router.use(express.raw({ type: 'application/json', limit: '1mb' }));

  router.post('/', async (req: Request, res: Response) => {
    if (!deps.stripe || !deps.webhookSecret) {
      res.status(503).json({ error: 'stripe_connect_not_configured' });
      return;
    }
    const signature = req.header('stripe-signature');
    if (!signature) {
      res.status(400).json({ error: 'missing_signature' });
      return;
    }
    const payload = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body);
    if (
      !deps.stripe.verifyWebhookSignature({
        payload,
        signature,
        secret: deps.webhookSecret,
      })
    ) {
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
    if (!event.id || !event.type) {
      res.status(400).json({ error: 'malformed_event' });
      return;
    }
    if (!deps.db) {
      // No DB — nothing to persist. Acknowledge so Stripe doesn't
      // retry; the operator can replay from Stripe later.
      res.json({ received: true, dry: true });
      return;
    }

    // Idempotency gate. PK on stripe_event_id means the second
    // delivery of the same event collides on insert and we return 200
    // without reprocessing.
    const inserted = await tryInsertEvent(deps.db, event, payload).catch((err: unknown) => {
      // Postgres unique-violation (23505) on the stripe_event_id PK = a
      // duplicate delivery. drizzle wraps the driver error, so match on the
      // pg code via the cause chain rather than the (now wrapper) message.
      if (pgErrorCode(err) === '23505') {
        return null;
      }
      throw err;
    });
    if (inserted === null) {
      logger.debug({ eventId: event.id, type: event.type }, 'duplicate stripe webhook delivery');
      res.json({ received: true, duplicate: true });
      return;
    }

    try {
      const handled = await dispatch(deps.db, event);
      await deps.db
        .update(webhookEvents)
        .set({
          state: handled ? 'PROCESSED' : 'IGNORED',
          processedAt: new Date(),
        })
        .where(eq(webhookEvents.stripeEventId, event.id));
      res.json({ received: true, handled });
    } catch (err) {
      logger.error(
        { err, eventId: event.id, type: event.type },
        'stripe connect webhook dispatch failed',
      );
      const message = err instanceof Error ? err.message : String(err);
      await deps.db
        .update(webhookEvents)
        .set({
          state: 'FAILED',
          lastError: message.slice(0, 4000),
          retryCount: 0,
          processedAt: new Date(),
        })
        .where(eq(webhookEvents.stripeEventId, event.id))
        .catch(() => undefined);
      res.status(500).json({ error: 'dispatch_failed' });
    }
  });

  return router;
}

async function tryInsertEvent(db: Database, event: StripeEvent, payload: string): Promise<string> {
  // Resolve the firm_id from the connected account id when possible.
  // Stripe attaches `account` for Connect events; without it the event
  // is platform-level (rare for Standard accounts).
  let firmId: string | null = null;
  if (event.account) {
    const [row] = await db
      .select({ firmId: firmSettingsProposals.firmId })
      .from(firmSettingsProposals)
      .where(eq(firmSettingsProposals.stripeAccountId, event.account))
      .limit(1);
    firmId = row?.firmId ?? null;
  }
  await db.insert(webhookEvents).values({
    stripeEventId: event.id,
    firmId,
    stripeAccountId: event.account ?? '',
    eventType: event.type,
    state: 'PENDING',
    payload: JSON.parse(payload) as Record<string, unknown>,
  });
  return event.id;
}

// =====================================================================
// dispatch — returns true if a handler matched + ran
// =====================================================================

async function dispatch(db: Database, event: StripeEvent): Promise<boolean> {
  const obj = event.data.object;
  switch (event.type) {
    case 'account.updated': {
      const acct = obj as {
        id?: string;
        capabilities?: Record<string, string>;
      };
      if (!acct.id) return false;
      await db
        .update(firmSettingsProposals)
        .set({
          stripeAccountCapabilities: acct.capabilities ?? {},
          updatedAt: new Date(),
        })
        .where(eq(firmSettingsProposals.stripeAccountId, acct.id));
      return true;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = obj as {
        id?: string;
        status?: string;
        current_period_start?: number;
        current_period_end?: number;
        cancel_at?: number | null;
        canceled_at?: number | null;
        pause_collection?: { behavior?: string } | null;
      };
      if (!sub.id) return false;
      await db
        .update(stripeSubscriptions)
        .set({
          stripeStatus: sub.status ?? 'unknown',
          currentPeriodStart: epochSecondsToDate(sub.current_period_start),
          currentPeriodEnd: epochSecondsToDate(sub.current_period_end),
          cancelAt: epochSecondsToDate(sub.cancel_at),
          cancelledAt:
            event.type === 'customer.subscription.deleted'
              ? new Date()
              : epochSecondsToDate(sub.canceled_at),
          pauseCollectionBehavior: sub.pause_collection?.behavior ?? null,
          updatedAt: new Date(),
        })
        .where(eq(stripeSubscriptions.stripeSubscriptionId, sub.id));
      return true;
    }

    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.finalized': {
      const inv = obj as {
        id?: string;
        status?: string;
        amount_due?: number;
        amount_paid?: number;
        amount_remaining?: number;
        due_date?: number | null;
        hosted_invoice_url?: string | null;
      };
      if (!inv.id) return false;
      const patch: Record<string, unknown> = {
        stripeStatus: inv.status ?? 'unknown',
        amountDueCents: inv.amount_due ?? 0,
        amountPaidCents: inv.amount_paid ?? 0,
        amountRemainingCents: inv.amount_remaining ?? 0,
        dueAt: epochSecondsToDate(inv.due_date),
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
        updatedAt: new Date(),
      };
      if (event.type === 'invoice.paid') {
        patch['paidAt'] = new Date();
      }
      await db.update(stripeInvoices).set(patch).where(eq(stripeInvoices.stripeInvoiceId, inv.id));
      return true;
    }

    case 'payment_method.attached':
    case 'payment_method.detached':
    case 'payment_method.automatically_updated': {
      // The proposal_mandates table is keyed on stripe_payment_method_id;
      // we don't currently track payment methods directly. Until P09
      // wires up firm-side card storage, just record the event for
      // observability.
      return false;
    }

    case 'mandate.updated': {
      const m = obj as { id?: string; status?: string };
      if (!m.id) return false;
      const next = mapMandateState(m.status);
      if (!next) return false;
      await db
        .update(paymentMandates)
        .set({
          state: next,
          activatedAt: next === 'ACTIVE' ? new Date() : undefined,
          invalidatedAt: next === 'INVALID' ? new Date() : undefined,
          revokedAt: next === 'REVOKED' ? new Date() : undefined,
          updatedAt: new Date(),
        })
        .where(eq(paymentMandates.stripeMandateId, m.id));
      return true;
    }

    case 'setup_intent.succeeded':
    case 'payout.paid':
    case 'payout.failed':
    case 'charge.dispute.created': {
      // Recorded in webhook_events; per-event handlers land with the
      // corresponding feature phases (P11 for charge.dispute, P21 for
      // setup_intent, etc.).
      return false;
    }

    default:
      logger.debug({ type: event.type }, 'unhandled stripe connect event');
      return false;
  }
}

function epochSecondsToDate(seconds: number | null | undefined): Date | null {
  if (seconds == null) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

function mapMandateState(
  stripeStatus: string | undefined,
): 'ACTIVE' | 'INVALID' | 'REVOKED' | 'PENDING_VERIFICATION' | null {
  switch (stripeStatus) {
    case 'active':
      return 'ACTIVE';
    case 'inactive':
      return 'INVALID';
    case 'pending':
      return 'PENDING_VERIFICATION';
    default:
      return null;
  }
}
