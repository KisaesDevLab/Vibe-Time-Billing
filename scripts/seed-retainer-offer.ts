// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Demo seed for the proposal-style tax-representation retainer offer.
// Sets up the whole flow for one firm so you can click through the portal
// offer page + the printable handout:
//   - enables the retainer feature + writes the offer intro/terms copy
//   - upserts two 1040 tiers (Standard / Premium) priced base + % of prep fee
//   - creates TWO live offers:
//       A) source return invoice UNPAID  → shows all three options
//       B) source return invoice PAID    → auto-adjusts to retainer-only
//
// Idempotent: clears its own prior DEMO offers + invoices first.
// Run with DATABASE_URL + FIRM_ID (optional APP_BASE_URL / PORTAL_BASE_URL).

import { sql } from 'drizzle-orm';

import { createDb } from '@vibe/db';

// Tier pricing inputs (cents / basis points).
const TIER1 = {
  base: 25000,
  bps: 1000,
  hours: 5,
  name: 'Standard',
  desc: 'Covers IRS/state notices and routine follow-up for {{ client.name }}.',
};
const TIER2 = {
  base: 50000,
  bps: 2500,
  hours: 12,
  name: 'Premium',
  desc: 'Everything in Standard **plus** audit representation and amended-return support.',
};
const RETURN_FEE = 150000; // $1,500 source tax-prep invoice (also the % basis)

const INTRO_MD =
  'Thank you, {{ client.name }}. Protect your return with prepaid representation: if the IRS or your state sends a notice or opens an audit, we handle it without per-hour billing surprises.';
const TERMS_MD =
  '## Representation terms\nPrepaid hours apply to notices, correspondence, and audit support for this return. Unused hours expire three years after the return due date. Representation does not include litigation or returns for other tax years.';

function price(base: number, bps: number, basis: number): number {
  return base + Math.round((bps * basis) / 10000);
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  const firmId = process.env['FIRM_ID'];
  if (!connectionString || !firmId) throw new Error('DATABASE_URL and FIRM_ID are required');
  const appBase = process.env['APP_BASE_URL'] ?? 'https://practice.vcpa.app';
  const portalBase = process.env['PORTAL_BASE_URL'] ?? 'https://portal.vcpa.app';

  const { db, close } = createDb({ connectionString });
  const exec = async <T = Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> => {
    const r = (await db.execute(q)) as unknown as { rows?: T[] } | T[];
    return Array.isArray(r) ? r : (r.rows ?? []);
  };

  try {
    // 1. A work code to use as the prep-fee basis + tier eligibility.
    const wc = await exec<{ id: string }>(
      sql`SELECT id FROM vibetb.work_code WHERE firm_id = ${firmId} ORDER BY name LIMIT 1`,
    );
    if (!wc[0]) throw new Error('no work_code for firm');
    const workCodeId = wc[0].id;

    // 2. Enable the feature + write the offer copy (upsert firm settings).
    await exec(sql`
      INSERT INTO vibetb.firm_retainer_settings
        (firm_id, feature_enabled, prep_fee_work_code_ids, offer_intro_md, offer_terms_md)
      VALUES (${firmId}, true, ${JSON.stringify([workCodeId])}::jsonb, ${INTRO_MD}, ${TERMS_MD})
      ON CONFLICT (firm_id) DO UPDATE SET
        feature_enabled = true,
        prep_fee_work_code_ids = ${JSON.stringify([workCodeId])}::jsonb,
        offer_intro_md = ${INTRO_MD},
        offer_terms_md = ${TERMS_MD},
        updated_at = now()`);

    // 3. Upsert the two 1040 tiers.
    const upsertTier = async (tier: 'TIER_1' | 'TIER_2', t: typeof TIER1): Promise<string> => {
      const rows = await exec<{ id: string }>(sql`
        INSERT INTO vibetb.retainer_tier_config
          (firm_id, return_type, tier, name, description, hours, base_fee_cents, pct_of_prep_fee_bps, is_active)
        VALUES (${firmId}, '1040', ${tier}, ${t.name}, ${t.desc}, ${t.hours}, ${t.base}, ${t.bps}, true)
        ON CONFLICT (firm_id, return_type, tier) DO UPDATE SET
          name = ${t.name}, description = ${t.desc}, hours = ${t.hours},
          base_fee_cents = ${t.base}, pct_of_prep_fee_bps = ${t.bps}, is_active = true, updated_at = now()
        RETURNING id`);
      const id = rows[0]!.id;
      await exec(sql`
        INSERT INTO vibetb.retainer_tier_eligible_service (tier_config_id, work_code_id)
        VALUES (${id}, ${workCodeId}) ON CONFLICT DO NOTHING`);
      return id;
    };
    const tier1Id = await upsertTier('TIER_1', TIER1);
    const tier2Id = await upsertTier('TIER_2', TIER2);

    // 4. Two engagements to attach offers to.
    const engs = await exec<{ id: string; client_id: string; name: string }>(sql`
      SELECT e.id, e.client_id, c.name
      FROM vibetb.engagement e JOIN vibetb.client c ON c.id = e.client_id
      WHERE c.firm_id = ${firmId}
      ORDER BY c.name LIMIT 2`);
    if (engs.length < 2) throw new Error('need at least 2 engagements for the firm');

    // 5. Idempotency: drop prior demo offers + their source invoices.
    await exec(sql`
      DELETE FROM vibetb.retainer_offer
      WHERE firm_id = ${firmId}
        AND invoice_id IN (SELECT id FROM vibetb.invoice WHERE firm_id = ${firmId} AND invoice_number LIKE 'DEMO-TAX-%')`);
    await exec(sql`
      DELETE FROM vibetb.invoice WHERE firm_id = ${firmId} AND invoice_number LIKE 'DEMO-TAX-%'`);

    const t1 = price(TIER1.base, TIER1.bps, RETURN_FEE);
    const t2 = price(TIER2.base, TIER2.bps, RETURN_FEE);

    const makeOffer = async (
      eng: { id: string; client_id: string; name: string },
      label: string,
      paid: boolean,
    ): Promise<string> => {
      // Tag the engagement with return type + year + due dates.
      await exec(sql`
        UPDATE vibetb.engagement SET return_type='1040', tax_year=2025,
          original_due_date='2026-04-15', extended_due_date='2026-10-15'
        WHERE id = ${eng.id}`);
      // Source tax-prep invoice.
      const inv = await exec<{ id: string }>(sql`
        INSERT INTO vibetb.invoice
          (firm_id, client_id, primary_engagement_id, invoice_number, issue_date, due_date,
           subtotal_cents, total_cents, paid_cents, status)
        VALUES (${firmId}, ${eng.client_id}, ${eng.id}, ${'DEMO-TAX-' + label},
                '2026-04-15', '2026-05-15', ${RETURN_FEE}, ${RETURN_FEE},
                ${paid ? RETURN_FEE : 0}, ${paid ? 'PAID' : 'SENT'})
        RETURNING id`);
      const invId = inv[0]!.id;
      const offer = await exec<{ id: string }>(sql`
        INSERT INTO vibetb.retainer_offer
          (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
           prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
           tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
        VALUES (${firmId}, ${eng.client_id}, ${eng.id}, ${invId}, '1040', 2025,
                ${RETURN_FEE}, ${tier1Id}, ${tier2Id}, ${t1}, ${t2},
                now() + interval '60 days', 'pending')
        RETURNING id`);
      return offer[0]!.id;
    };

    const offerUnpaid = await makeOffer(engs[0]!, 'A', false);
    const offerPaid = await makeOffer(engs[1]!, 'B', true);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          tiers: {
            standard: { priceCents: t1, bundledCents: RETURN_FEE + t1 },
            premium: { priceCents: t2, bundledCents: RETURN_FEE + t2 },
            returnFeeCents: RETURN_FEE,
          },
          unpaidOffer: {
            client: engs[0]!.name,
            offerId: offerUnpaid,
            staffPrintUrl: `${appBase}/api/staff/retainers/offers/${offerUnpaid}/print.html`,
            portalUrl: `${portalBase}/retainer-offers/${offerUnpaid}`,
            note: 'Shows all three options (return only / +Standard / +Premium).',
          },
          paidOffer: {
            client: engs[1]!.name,
            offerId: offerPaid,
            staffPrintUrl: `${appBase}/api/staff/retainers/offers/${offerPaid}/print.html`,
            portalUrl: `${portalBase}/retainer-offers/${offerPaid}`,
            note: 'Return already paid → auto-adjusts to retainer-only add-ons.',
          },
          hint: 'Staff print URLs open with your practice login. Portal URLs need a client portal session for that client.',
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
