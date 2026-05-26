// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R3 — activateRetainerFromPaidInvoice. Called by the Stripe webhook
// (and the /payments/receive handler) when an invoice marked
// retainer_offer_id is fully paid. Wraps the activation in a single
// transaction with SELECT FOR UPDATE on the offer row so Stripe retries
// can't double-activate (idempotency belt) and the UNIQUE constraint
// on retainer.engagement_id is the suspender (D2).

import { and, eq, sql as drz } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  engagements,
  invoices,
  retainerEligibleServices,
  retainerLedger,
  retainerOffers,
  retainerTierConfigs,
  retainerTierEligibleServices,
  retainers,
} from '@vibe/db/schema';
import { computeExpiryDate } from '@vibe/core/retainers';

import { logger } from '../logger';
import type { RetainerMailDispatch } from './notifications';

export type ActivationResult =
  | { kind: 'activated'; retainerId: string }
  | { kind: 'idempotent'; retainerId: string }
  | { kind: 'error'; reason: string };

export async function activateRetainerFromPaidInvoice(
  db: Database,
  invoiceId: string,
  args: {
    actorAppUserId?: string | null;
    now?: Date;
    /** Optional staff-mail dispatcher. When provided, sends client +
     *  staff "retainer activated" notifications post-commit. */
    sendEmail?: RetainerMailDispatch;
  } = {},
): Promise<ActivationResult> {
  const now = args.now ?? new Date();
  // Captured inside the tx so we can schedule queue jobs AFTER commit
  // (BullMQ adds aren't transactional with Postgres). null until we
  // actually activate a retainer this call.
  let activatedRetainerId: string | null = null;
  let activatedOfferId: string | null = null;
  let activatedExpiryDate: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
      // Resolve invoice → offer id.
      const [inv] = await tx
        .select({
          id: invoices.id,
          firmId: invoices.firmId,
          clientId: invoices.clientId,
          retainerOfferId: invoices.retainerOfferId,
        })
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .limit(1);
      if (!inv) {
        return { kind: 'error', reason: 'invoice_not_found' } as const;
      }
      if (!inv.retainerOfferId) {
        return { kind: 'error', reason: 'invoice_not_a_retainer_purchase' } as const;
      }

      // Lock the offer row. Stripe retries will block here while the
      // first activation runs; the second tx will then see status =
      // 'purchased' and short-circuit to idempotent.
      const offerExec = await tx.execute(
        drz`SELECT * FROM ${retainerOffers}
            WHERE id = ${inv.retainerOfferId}
            FOR UPDATE`,
      );
      const offerRow = unwrapRow<{
        id: string;
        firm_id: string;
        client_id: string;
        engagement_id: string;
        return_type: string;
        tax_year: number;
        status: string;
        purchased_tier: 'TIER_1' | 'TIER_2' | null;
        purchased_invoice_id: string | null;
        tier_1_tier_config_id: string;
        tier_2_tier_config_id: string;
        tier_1_price_cents: string | number;
        tier_2_price_cents: string | number;
        eligibility_overrides_json: { tier1?: string[]; tier2?: string[] } | null;
      }>(offerExec);
      if (!offerRow) {
        return { kind: 'error', reason: 'offer_not_found' } as const;
      }

      // Idempotency: if already purchased + linked to this invoice, return
      // the existing retainer.
      if (offerRow.status === 'purchased' && offerRow.purchased_invoice_id === inv.id) {
        const [existing] = await tx
          .select({ id: retainers.id })
          .from(retainers)
          .where(eq(retainers.offerId, offerRow.id))
          .limit(1);
        if (existing) {
          logger.info(
            { invoiceId: inv.id, retainerId: existing.id },
            'retainer activation: idempotent (already purchased)',
          );
          return { kind: 'idempotent', retainerId: existing.id } as const;
        }
        return { kind: 'error', reason: 'offer_purchased_but_no_retainer' } as const;
      }

      if (offerRow.status !== 'pending_payment') {
        return { kind: 'error', reason: 'offer_not_pending_payment' } as const;
      }
      if (!offerRow.purchased_tier) {
        return { kind: 'error', reason: 'offer_missing_purchased_tier' } as const;
      }

      // Resolve tier config + price snapshot.
      const tierConfigId =
        offerRow.purchased_tier === 'TIER_1'
          ? offerRow.tier_1_tier_config_id
          : offerRow.tier_2_tier_config_id;
      const priceCents =
        offerRow.purchased_tier === 'TIER_1'
          ? Number(offerRow.tier_1_price_cents)
          : Number(offerRow.tier_2_price_cents);
      const [tierConfig] = await tx
        .select()
        .from(retainerTierConfigs)
        .where(eq(retainerTierConfigs.id, tierConfigId))
        .limit(1);
      if (!tierConfig) {
        return { kind: 'error', reason: 'tier_config_vanished' } as const;
      }

      // Load engagement due-date pair for expiry math (D3).
      const [eng] = await tx
        .select({
          originalDueDate: engagements.originalDueDate,
          extendedDueDate: engagements.extendedDueDate,
        })
        .from(engagements)
        .where(eq(engagements.id, offerRow.engagement_id))
        .limit(1);
      if (!eng) {
        return { kind: 'error', reason: 'engagement_not_found' } as const;
      }
      const expiryDate = computeExpiryDate({
        originalDueDate: eng.originalDueDate,
        extendedDueDate: eng.extendedDueDate,
      });
      const purchaseDate = isoDate(now);

      // Insert retainer. UNIQUE (engagement_id) is the D2 backstop —
      // a second-call with a different invoice would land here too.
      const [newRetainer] = await tx
        .insert(retainers)
        .values({
          firmId: offerRow.firm_id,
          clientId: offerRow.client_id,
          engagementId: offerRow.engagement_id,
          offerId: offerRow.id,
          purchaseInvoiceId: inv.id,
          tier: offerRow.purchased_tier,
          returnType: offerRow.return_type as '1040',
          taxYear: offerRow.tax_year,
          tierConfigId,
          name: tierConfig.name,
          hoursPurchased: String(tierConfig.hours),
          hoursConsumed: '0',
          priceCents,
          purchaseDate,
          expiryDate,
          status: 'active',
        })
        .returning({ id: retainers.id });
      if (!newRetainer) throw new Error('retainer_insert_failed');

      // Snapshot eligibility — overrides win (D18); fallback to tier
      // config's current eligibility set.
      const overrideIds =
        offerRow.purchased_tier === 'TIER_1'
          ? offerRow.eligibility_overrides_json?.tier1
          : offerRow.eligibility_overrides_json?.tier2;
      let eligibilityIds: string[];
      if (overrideIds && overrideIds.length > 0) {
        eligibilityIds = overrideIds;
      } else {
        const rows = await tx
          .select({ workCodeId: retainerTierEligibleServices.workCodeId })
          .from(retainerTierEligibleServices)
          .where(eq(retainerTierEligibleServices.tierConfigId, tierConfigId));
        eligibilityIds = rows.map((r) => r.workCodeId);
      }
      if (eligibilityIds.length > 0) {
        await tx.insert(retainerEligibleServices).values(
          eligibilityIds.map((workCodeId) => ({
            retainerId: newRetainer.id,
            workCodeId,
          })),
        );
      }

      // Mark offer purchased.
      await tx
        .update(retainerOffers)
        .set({
          status: 'purchased',
          purchasedAt: now,
          purchasedInvoiceId: inv.id,
          updatedAt: now,
        })
        .where(eq(retainerOffers.id, offerRow.id));

      // Engagement convenience pointer (mirror retainer.engagement_id).
      await tx
        .update(engagements)
        .set({ retainerId: newRetainer.id })
        .where(eq(engagements.id, offerRow.engagement_id));

      // Activation seed row in the ledger.
      await tx.insert(retainerLedger).values({
        retainerId: newRetainer.id,
        kind: 'ACTIVATION',
        hoursDelta: '0',
        hoursBalanceAfter: String(tierConfig.hours),
        createdById: args.actorAppUserId ?? null,
      });

      logger.info(
        { retainerId: newRetainer.id, offerId: offerRow.id, invoiceId: inv.id },
        'retainer activated',
      );
      // Stash for post-commit reminder cancel + warning schedule.
      activatedRetainerId = newRetainer.id;
      activatedOfferId = offerRow.id;
      activatedExpiryDate = expiryDate;
      return { kind: 'activated', retainerId: newRetainer.id } as const;
    });
    // Post-commit: cancel any in-flight offer reminders + schedule
    // expiry-warning jobs + send activation emails. Best-effort —
    // failures here log only.
    if (activatedRetainerId && activatedOfferId && activatedExpiryDate) {
      try {
        const { cancelOfferReminders, scheduleRetainerWarnings } = await import('./scheduler');
        await cancelOfferReminders(activatedOfferId);
        await scheduleRetainerWarnings({
          retainerId: activatedRetainerId,
          expiryDate: activatedExpiryDate,
          now,
        });
      } catch (err) {
        logger.error(
          { err, retainerId: activatedRetainerId, offerId: activatedOfferId },
          'retainer activation post-commit scheduling failed',
        );
      }
      if (args.sendEmail) {
        try {
          const { notifyRetainerActivated } = await import('./notifications');
          await notifyRetainerActivated(db, activatedRetainerId, args.sendEmail);
        } catch (err) {
          logger.error(
            { err, retainerId: activatedRetainerId },
            'retainer activation notification failed',
          );
        }
      }
    }
    return result;
  } catch (err) {
    // Unique-violation on engagement_id (D2) — should already be caught
    // above, but the constraint is the suspender. Treat as idempotent
    // by looking up the existing retainer.
    const msg = err instanceof Error ? err.message : String(err);
    if (/retainer_engagement_uk|duplicate key/.test(msg)) {
      const [existing] = await db
        .select({ id: retainers.id })
        .from(retainers)
        .where(eq(retainers.purchaseInvoiceId, invoiceId))
        .limit(1);
      if (existing) {
        logger.info(
          { invoiceId, retainerId: existing.id },
          'retainer activation: idempotent (caught engagement-uk)',
        );
        return { kind: 'idempotent', retainerId: existing.id };
      }
    }
    logger.error({ err, invoiceId }, 'retainer activation failed');
    return { kind: 'error', reason: msg };
  }
}

function unwrapRow<T>(raw: unknown): T | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return (raw[0] as T) ?? null;
  }
  if (typeof raw === 'object' && raw !== null && 'rows' in raw) {
    const rows = (raw as { rows?: T[] }).rows ?? [];
    return rows[0] ?? null;
  }
  return raw as T;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Suppress unused-import lint when caller doesn't reach for `and`.
void and;
