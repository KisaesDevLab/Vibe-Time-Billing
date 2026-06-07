// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Proposal-style presentation of a retainer offer (the "hybrid": proposal
// look, retainer engine). Builds the data the portal page + printable PDF
// render from — the three options (tax return only / + Standard / + Premium),
// firm branding, and firm-authored intro/terms — and shares the
// retainer-purchase-invoice creation between the portal and staff select paths.
//
// Pricing is NOT recomputed here: the offer's tier{1,2}PriceCents are already
// frozen as base_fee + pct_of_prep_fee. We only add the source return invoice
// total for the bundled cards and decide whether the return is already paid
// (which collapses the "return only" option — requirement #5).

import { eq, inArray, sql as drz } from 'drizzle-orm';

import { resolveMergeTokens } from '@vibe/core/proposals';
import type { Database } from '@vibe/db';
import {
  clients,
  firmRetainerSettings,
  firmSettings,
  firms,
  invoiceLineItems,
  invoices,
  retainerTierConfigs,
  type retainerOffers,
} from '@vibe/db/schema';

export type OfferRow = typeof retainerOffers.$inferSelect;
type Tier = 'TIER_1' | 'TIER_2';

export interface OfferTierView {
  tier: Tier;
  name: string;
  description: string | null;
  hours: number;
  /** The retainer add-on price (frozen base + % of prep fee). */
  retainerPriceCents: number;
  /** Return fee + retainer (what "return + representation" costs together). */
  bundledPriceCents: number;
}

export interface RetainerOfferPresentation {
  offer: {
    id: string;
    status: OfferRow['status'];
    returnType: string;
    taxYear: number;
    offerExpiresAt: string;
    purchasedTier: Tier | null;
    purchasedInvoiceId: string | null;
  };
  returnInvoice: {
    id: string;
    totalCents: number;
    paidCents: number;
    status: string;
    /** True once the source tax-return invoice is paid → hide "return only". */
    returnPaid: boolean;
  };
  tiers: OfferTierView[];
  branding: { firmName: string; logoUrl: string | null; accentColor: string | null };
  client: { name: string };
  introMd: string | null;
  termsMd: string | null;
}

/**
 * Build the full proposal-style presentation for a retainer offer. The caller
 * has already loaded + access-scoped the offer row.
 */
export async function buildRetainerOfferPresentation(
  db: Database,
  offer: OfferRow,
): Promise<RetainerOfferPresentation> {
  const [srcInvoice] = await db
    .select({
      id: invoices.id,
      totalCents: invoices.totalCents,
      paidCents: invoices.paidCents,
      status: invoices.status,
    })
    .from(invoices)
    .where(eq(invoices.id, offer.invoiceId))
    .limit(1);

  const configs = await db
    .select({
      id: retainerTierConfigs.id,
      tier: retainerTierConfigs.tier,
      name: retainerTierConfigs.name,
      description: retainerTierConfigs.description,
      hours: retainerTierConfigs.hours,
    })
    .from(retainerTierConfigs)
    .where(inArray(retainerTierConfigs.id, [offer.tier1TierConfigId, offer.tier2TierConfigId]));
  const byId = new Map(configs.map((c) => [c.id, c]));

  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, offer.firmId))
    .limit(1);
  const [brand] = await db
    .select({
      displayName: firmSettings.brandDisplayName,
      logoUrl: firmSettings.brandLogoUrl,
      accentColor: firmSettings.brandAccentColor,
    })
    .from(firmSettings)
    .where(eq(firmSettings.firmId, offer.firmId))
    .limit(1);
  const [settings] = await db
    .select({
      introMd: firmRetainerSettings.offerIntroMd,
      termsMd: firmRetainerSettings.offerTermsMd,
    })
    .from(firmRetainerSettings)
    .where(eq(firmRetainerSettings.firmId, offer.firmId))
    .limit(1);
  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, offer.clientId))
    .limit(1);

  const returnTotal = Number(srcInvoice?.totalCents ?? 0);
  const returnPaid = srcInvoice?.status === 'PAID';

  // Resolve {{ client.name }} / {{ firm.name }} / {{ today }} in firm-authored
  // copy + tier descriptions. Never throws — falls back to the raw text.
  const firmName = brand?.displayName || firm?.name || '';
  const mergeCtx = {
    client: { name: client?.name ?? '', legal_name: client?.name ?? '' },
    firm: { name: firmName, legal_name: firmName },
    today: new Date().toISOString().slice(0, 10),
  } as Parameters<typeof resolveMergeTokens>[1];
  const resolve = (md: string | null): string | null => {
    if (!md) return md;
    try {
      return resolveMergeTokens(md, mergeCtx).output;
    } catch {
      return md;
    }
  };

  const tierView = (tier: Tier, configId: string, retainerPriceCents: number): OfferTierView => {
    const cfg = byId.get(configId);
    return {
      tier,
      name: cfg?.name ?? (tier === 'TIER_1' ? 'Standard' : 'Premium'),
      description: resolve(cfg?.description ?? null),
      hours: cfg ? Number(cfg.hours) : 0,
      retainerPriceCents,
      bundledPriceCents: returnTotal + retainerPriceCents,
    };
  };

  return {
    offer: {
      id: offer.id,
      status: offer.status,
      returnType: offer.returnType,
      taxYear: offer.taxYear,
      offerExpiresAt:
        offer.offerExpiresAt instanceof Date
          ? offer.offerExpiresAt.toISOString()
          : String(offer.offerExpiresAt),
      purchasedTier: offer.purchasedTier as Tier | null,
      purchasedInvoiceId: offer.purchasedInvoiceId,
    },
    returnInvoice: {
      id: srcInvoice?.id ?? offer.invoiceId,
      totalCents: returnTotal,
      paidCents: Number(srcInvoice?.paidCents ?? 0),
      status: srcInvoice?.status ?? 'UNKNOWN',
      returnPaid,
    },
    tiers: [
      tierView('TIER_1', offer.tier1TierConfigId, Number(offer.tier1PriceCents)),
      tierView('TIER_2', offer.tier2TierConfigId, Number(offer.tier2PriceCents)),
    ],
    branding: {
      firmName: firmName || 'Your firm',
      logoUrl: brand?.logoUrl ?? null,
      accentColor: brand?.accentColor ?? null,
    },
    client: { name: client?.name ?? 'Client' },
    introMd: resolve(settings?.introMd ?? null),
    termsMd: resolve(settings?.termsMd ?? null),
  };
}

/**
 * Create the retainer-purchase AR invoice for a chosen tier and flip the offer
 * to pending_payment. Shared by the portal (client self-select) and staff
 * (in-office select on the client's behalf) paths. Paying this invoice — online
 * via Stripe OR a staff-recorded office payment — activates the retainer.
 *
 * The caller is responsible for loading + access-scoping the offer and for
 * validating it is still selectable (status pending + not expired).
 */
export async function createRetainerPurchaseInvoice(
  db: Database,
  offer: OfferRow,
  tier: Tier,
): Promise<{ invoiceId: string; invoiceNumber: string; priceCents: number }> {
  const priceCents =
    tier === 'TIER_1' ? Number(offer.tier1PriceCents) : Number(offer.tier2PriceCents);
  const invoiceNumber = await nextInvoiceNumber(db, offer.firmId, 'RET');
  const issueDate = new Date().toISOString().slice(0, 10);
  const dueDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  const invoiceId = await db.transaction(async (tx) => {
    const [inv] = await tx
      .insert(invoices)
      .values({
        firmId: offer.firmId,
        clientId: offer.clientId,
        primaryEngagementId: offer.engagementId,
        invoiceNumber,
        issueDate,
        dueDate,
        subtotalCents: priceCents,
        totalCents: priceCents,
        status: 'SENT',
        retainerOfferId: offer.id,
      })
      .returning({ id: invoices.id });
    if (!inv) throw new Error('invoice_insert_failed');
    await tx.insert(invoiceLineItems).values({
      invoiceId: inv.id,
      kind: 'RETAINER',
      description: `Retainer purchase — ${tier === 'TIER_1' ? 'Standard' : 'Premium'} coverage for TY${offer.taxYear} ${offer.returnType}`,
      amountCents: priceCents,
      engagementId: offer.engagementId,
      sourceRefType: 'retainer_offer',
      sourceRefId: offer.id,
      sortOrder: 0,
    });
    const { retainerOffers } = await import('@vibe/db/schema');
    await tx
      .update(retainerOffers)
      .set({
        status: 'pending_payment',
        purchasedTier: tier,
        purchasedInvoiceId: inv.id,
        updatedAt: new Date(),
      })
      .where(eq(retainerOffers.id, offer.id));
    return inv.id;
  });

  return { invoiceId, invoiceNumber, priceCents };
}

async function nextInvoiceNumber(db: Database, firmId: string, prefix: string): Promise<string> {
  const [row] = await db
    .select({
      n: drz<number>`COALESCE(MAX(CAST(SUBSTRING(${invoices.invoiceNumber} FROM '[0-9]+$') AS INTEGER)), 0)`,
    })
    .from(invoices)
    .where(eq(invoices.firmId, firmId));
  const next = Number(row?.n ?? 0) + 1;
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(next).padStart(4, '0')}`;
}
