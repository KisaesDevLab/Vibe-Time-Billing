// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Hybrid retainer offer: proposal-style presentation + shared select helper +
// printable handout. Covers the data builder (return fee + paid flag, tiers,
// branding, resolved merge tokens), the shared invoice-creation path, and the
// PDF template's paid-aware tier hiding.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { invoices, retainerOffers } from '@vibe/db/schema';
import {
  buildRetainerOfferPresentation,
  createRetainerPurchaseInvoice,
} from '../retainers/offer-presentation';
import { renderRetainerOfferHtml } from '../pdf-templates/retainer-offer';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

async function seedOffer(opts?: { returnPaid?: boolean }): Promise<{
  firmId: string;
  offerId: string;
  srcInvId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId, workCodeId } = seed;

  await harness.db.execute(
    sql`INSERT INTO firm_retainer_settings
          (firm_id, feature_enabled, prep_fee_work_code_ids, offer_intro_md, offer_terms_md)
        VALUES (${firmId}, true, ${JSON.stringify([workCodeId])}::jsonb,
                'Hello {{ client.name }} — protect your return.',
                '## Terms\nStandard representation terms apply.')`,
  );
  await harness.db.execute(
    sql`UPDATE engagement SET return_type='1040', tax_year=2025,
        original_due_date='2026-04-15', extended_due_date='2026-10-15' WHERE id = ${engagementId}`,
  );
  const tc = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, description, hours, base_fee_cents, pct_of_prep_fee_bps, is_active)
        VALUES
          (${firmId}, '1040', 'TIER_1', 'Standard', 'Covers notices', 5, 25000, 1000, true),
          (${firmId}, '1040', 'TIER_2', 'Premium', 'Covers audits for {{ client.name }}', 12, 50000, 2500, true)
        RETURNING id, tier`,
  );
  const tcRows = (tc as unknown as { rows: { id: string; tier: 'TIER_1' | 'TIER_2' }[] }).rows;
  const tier1 = tcRows.find((r) => r.tier === 'TIER_1')!.id;
  const tier2 = tcRows.find((r) => r.tier === 'TIER_2')!.id;

  const srcStatus = opts?.returnPaid ? 'PAID' : 'SENT';
  const srcPaid = opts?.returnPaid ? 150000 : 0;
  const srcInv = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                             issue_date, due_date, subtotal_cents, total_cents, paid_cents, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'TAX-001', '2026-04-15', '2026-05-15',
                150000, 150000, ${srcPaid}, ${srcStatus})
        RETURNING id`,
  );
  const srcInvId = (srcInv as unknown as { rows: { id: string }[] }).rows[0]!.id;

  const offer = await harness.db.execute(
    sql`INSERT INTO retainer_offer
          (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
           prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
           tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, ${srcInvId}, '1040', 2025,
                150000, ${tier1}, ${tier2}, 40000, 87500,
                now() + interval '60 days', 'pending')
        RETURNING id`,
  );
  const offerId = (offer as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return { firmId, offerId, srcInvId };
}

describe('retainer offer presentation', () => {
  it('builds 3-option data with return fee, bundled prices, and resolved tokens', async () => {
    const { offerId } = await seedOffer();
    const [offer] = await harness.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, offerId));
    const p = await buildRetainerOfferPresentation(harness.db, offer!);

    expect(p.returnInvoice.totalCents).toBe(150000);
    expect(p.returnInvoice.returnPaid).toBe(false);
    expect(p.tiers).toHaveLength(2);
    // bundled = return fee + retainer price
    expect(p.tiers[0]).toMatchObject({
      tier: 'TIER_1',
      name: 'Standard',
      retainerPriceCents: 40000,
      bundledPriceCents: 190000,
    });
    expect(p.tiers[1]).toMatchObject({
      tier: 'TIER_2',
      name: 'Premium',
      retainerPriceCents: 87500,
      bundledPriceCents: 237500,
    });
    // merge tokens resolved against the seeded client name.
    expect(p.introMd).toContain('Test Client Co');
    expect(p.tiers[1]!.description).toContain('Test Client Co');
    expect(p.termsMd).toContain('Standard representation terms');
  });

  it('flags returnPaid once the source invoice is PAID', async () => {
    const { offerId } = await seedOffer({ returnPaid: true });
    const [offer] = await harness.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, offerId));
    const p = await buildRetainerOfferPresentation(harness.db, offer!);
    expect(p.returnInvoice.returnPaid).toBe(true);
  });

  it('createRetainerPurchaseInvoice issues an invoice and flips the offer', async () => {
    const { offerId } = await seedOffer();
    const [offer] = await harness.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, offerId));
    const r = await createRetainerPurchaseInvoice(harness.db, offer!, 'TIER_2');
    expect(r.priceCents).toBe(87500);

    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, r.invoiceId));
    expect(inv!.retainerOfferId).toBe(offerId);
    expect(Number(inv!.totalCents)).toBe(87500);

    const [after] = await harness.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, offerId));
    expect(after!.status).toBe('pending_payment');
    expect(after!.purchasedTier).toBe('TIER_2');
    expect(after!.purchasedInvoiceId).toBe(r.invoiceId);
  });
});

describe('retainer offer print template', () => {
  it('shows all three options (return + two tiers) when the return is unpaid', async () => {
    const { offerId } = await seedOffer();
    const [offer] = await harness.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, offerId));
    const html = renderRetainerOfferHtml(await buildRetainerOfferPresentation(harness.db, offer!));
    expect(html).toContain('Tax return only');
    expect(html).toContain('$1,500.00'); // return fee
    expect(html).toContain('$1,900.00'); // return + Standard
    expect(html).toContain('$2,375.00'); // return + Premium
    expect(html).toContain('Standard representation terms');
  });

  it('omits the return-only option once the return is paid', async () => {
    const { offerId } = await seedOffer({ returnPaid: true });
    const [offer] = await harness.db
      .select()
      .from(retainerOffers)
      .where(eq(retainerOffers.id, offerId));
    const html = renderRetainerOfferHtml(await buildRetainerOfferPresentation(harness.db, offer!));
    expect(html).not.toContain('Tax return only');
    expect(html).toContain('$400.00'); // Standard add-on only (retainer price)
    expect(html).toContain('$875.00'); // Premium add-on only
  });
});
