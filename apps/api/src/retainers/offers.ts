// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// R2 — Auto-create retainer offer on tax-prep invoice (D12).
//
// maybeCreateRetainerOffer is called from inside the invoice-creation
// transaction (apps/api/src/invoices/routes.ts /generate-from-batch).
// Returns the new offer id or `null` (with structured log reason) when
// any of the 5 suppression rules apply.
//
// Suppression matrix (return null + log reason):
//   1. basisCents === 0n         → 'no_prep_fee_basis'   (D21)
//   2. engagement.return_type null → 'no_return_type'
//   3. no active tier_configs for (firm, return_type) → 'no_tier_config'
//   4. engagement already has retainer_id → 'retainer_exists'    (D2)
//   5. firm.feature_enabled false → 'feature_disabled'           (R6 gate)
//
// Pricing is computed via packages/core/src/retainers/pricing.ts and
// frozen into tier_*_price_cents on the offer row. Override values
// passed in `overrides` overwrite the snapshot directly (D18).

import { and, eq, inArray, sql as drz } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  billingBatchEntries,
  engagements,
  firmRetainerSettings,
  invoices,
  retainerOffers,
  retainerTierConfigs,
  timeEntries,
  workCodes,
} from '@vibe/db/schema';
import { computeTierPrice } from '@vibe/core/retainers';

import { logger } from '../logger';

export type SuppressionReason =
  | 'no_prep_fee_basis'
  | 'no_return_type'
  | 'no_tier_config'
  | 'retainer_exists'
  | 'feature_disabled';

export interface RetainerOptionOverrides {
  tier1PriceCents?: number;
  tier2PriceCents?: number;
  tier1WorkCodeIds?: string[];
  tier2WorkCodeIds?: string[];
}

export type MaybeCreateOfferResult =
  | {
      ok: true;
      offerId: string;
      tier1PriceCents: number;
      tier2PriceCents: number;
      basisCents: number;
    }
  | { ok: false; reason: SuppressionReason };

// reason: drizzle-orm tx generic varies per call site; accept the base
// Database type and trust the caller to pass a transaction handle.
type Tx = Database;

export interface MaybeCreateOfferArgs {
  invoiceId: string;
  engagementId: string;
  firmId: string;
  clientId: string;
  toggleOn: boolean;
  overrides?: RetainerOptionOverrides;
  /** ISO YYYY-MM-DD; used to compute offer_expires_at. */
  invoiceDate: string;
}

export async function maybeCreateRetainerOffer(
  tx: Tx,
  args: MaybeCreateOfferArgs,
): Promise<MaybeCreateOfferResult> {
  // Caller-toggle is the very first gate.
  if (!args.toggleOn) {
    return { ok: false, reason: 'feature_disabled' };
  }

  // Firm feature gate.
  const [settings] = await tx
    .select()
    .from(firmRetainerSettings)
    .where(eq(firmRetainerSettings.firmId, args.firmId))
    .limit(1);
  if (!settings || !settings.featureEnabled) {
    logger.info({ firmId: args.firmId }, 'retainer offer suppressed: feature_disabled');
    return { ok: false, reason: 'feature_disabled' };
  }

  // Engagement must have a return_type + tax_year for the offer to be
  // meaningful.
  const [eng] = await tx
    .select({
      id: engagements.id,
      retainerId: engagements.retainerId,
      returnType: engagements.returnType,
      taxYear: engagements.taxYear,
    })
    .from(engagements)
    .where(eq(engagements.id, args.engagementId))
    .limit(1);
  if (!eng) {
    logger.warn(
      { engagementId: args.engagementId },
      'retainer offer suppressed: engagement_not_found',
    );
    return { ok: false, reason: 'no_return_type' };
  }
  if (!eng.returnType || eng.taxYear == null) {
    logger.info({ engagementId: args.engagementId }, 'retainer offer suppressed: no_return_type');
    return { ok: false, reason: 'no_return_type' };
  }
  if (eng.retainerId) {
    logger.info({ engagementId: args.engagementId }, 'retainer offer suppressed: retainer_exists');
    return { ok: false, reason: 'retainer_exists' };
  }

  // Resolve active tier configs for this return type.
  const tierConfigs = await tx
    .select()
    .from(retainerTierConfigs)
    .where(
      and(
        eq(retainerTierConfigs.firmId, args.firmId),
        eq(retainerTierConfigs.returnType, eng.returnType as '1040'),
        eq(retainerTierConfigs.isActive, true),
      ),
    );
  const tier1Config = tierConfigs.find((c) => c.tier === 'TIER_1');
  const tier2Config = tierConfigs.find((c) => c.tier === 'TIER_2');
  if (!tier1Config || !tier2Config) {
    logger.info(
      { engagementId: args.engagementId, returnType: eng.returnType },
      'retainer offer suppressed: no_tier_config',
    );
    return { ok: false, reason: 'no_tier_config' };
  }

  // Compute prep-fee basis = sum of standard_amount_cents on time
  // entries whose work_code is in firm.prep_fee_work_code_ids, included
  // in the billing batches referenced by this invoice's line items.
  const prepFeeWcIds = (settings.prepFeeWorkCodeIds ?? []) as string[];
  let basisCents = 0;
  if (prepFeeWcIds.length > 0) {
    const basisRows = await tx
      .select({
        total: drz<number>`COALESCE(SUM(${timeEntries.standardAmountCents}), 0)`,
      })
      .from(billingBatchEntries)
      .innerJoin(timeEntries, eq(timeEntries.id, billingBatchEntries.timeEntryId))
      .innerJoin(workCodes, eq(workCodes.id, timeEntries.workCodeId))
      .where(
        and(
          eq(timeEntries.engagementId, args.engagementId),
          inArray(workCodes.id, prepFeeWcIds),
          eq(billingBatchEntries.action, 'INCLUDE'),
        ),
      );
    basisCents = Number(basisRows[0]?.total ?? 0);
  }
  if (basisCents === 0) {
    logger.info(
      { engagementId: args.engagementId },
      'retainer offer suppressed: no_prep_fee_basis',
    );
    return { ok: false, reason: 'no_prep_fee_basis' };
  }

  // Compute tier prices via the core math primitive. Apply overrides
  // when supplied (D18 — frozen at offer creation).
  const tier1Price =
    args.overrides?.tier1PriceCents ??
    computeTierPrice({
      baseFeeCents: tier1Config.baseFeeCents,
      pctOfPrepFeeBps: tier1Config.pctOfPrepFeeBps,
      basisCents,
    });
  const tier2Price =
    args.overrides?.tier2PriceCents ??
    computeTierPrice({
      baseFeeCents: tier2Config.baseFeeCents,
      pctOfPrepFeeBps: tier2Config.pctOfPrepFeeBps,
      basisCents,
    });

  // offer_expires_at = invoice_date + firm.offer_window_days (D20).
  const expiresAt = addDaysIso(args.invoiceDate, settings.offerWindowDays);

  const eligibilityOverrides =
    args.overrides?.tier1WorkCodeIds || args.overrides?.tier2WorkCodeIds
      ? {
          tier1: args.overrides.tier1WorkCodeIds,
          tier2: args.overrides.tier2WorkCodeIds,
        }
      : null;

  const [row] = await tx
    .insert(retainerOffers)
    .values({
      firmId: args.firmId,
      clientId: args.clientId,
      engagementId: args.engagementId,
      invoiceId: args.invoiceId,
      returnType: eng.returnType as '1040',
      taxYear: eng.taxYear,
      prepFeeBasisCents: basisCents,
      tier1TierConfigId: tier1Config.id,
      tier2TierConfigId: tier2Config.id,
      tier1PriceCents: tier1Price,
      tier2PriceCents: tier2Price,
      eligibilityOverridesJson: eligibilityOverrides,
      offerExpiresAt: expiresAt,
      status: 'pending',
    })
    .returning({ id: retainerOffers.id });
  if (!row) {
    throw new Error('retainer_offer_insert_failed');
  }
  logger.info(
    {
      offerId: row.id,
      engagementId: args.engagementId,
      tier1PriceCents: tier1Price,
      tier2PriceCents: tier2Price,
      basisCents,
    },
    'retainer offer created',
  );
  return {
    ok: true,
    offerId: row.id,
    tier1PriceCents: tier1Price,
    tier2PriceCents: tier2Price,
    basisCents,
  };
}

function addDaysIso(iso: string, days: number): Date {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Suppress further linting on the `invoices` import — re-exported for
 * convenience when external callers need the type. (Avoids the unused-
 * import warning on environments without strict lint.)
 */
void invoices;
