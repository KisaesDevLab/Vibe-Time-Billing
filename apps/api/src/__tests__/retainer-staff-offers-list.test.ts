// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Staff retainer offers list (proposal surface): GET /api/staff/retainers/offers
// is enriched with the client name and the client-facing portal link so the
// staff dashboard can render the offer table + "Copy link" action. The staff
// in-office select shares the portal's invoice-creation path.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createRetainerRouter } from '../retainers/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const PORTAL_BASE = 'https://portal.firm.example';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  app.use(
    '/api/staff/retainers',
    createRetainerRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['admin']]]),
      portalBaseUrl: PORTAL_BASE,
    }),
  );
  return app;
}

async function seedOffer(): Promise<string> {
  const { firmId, clientId, engagementId, workCodeId } = seed;
  await harness.db.execute(
    sql`INSERT INTO firm_retainer_settings (firm_id, feature_enabled, prep_fee_work_code_ids)
        VALUES (${firmId}, true, ${JSON.stringify([workCodeId])}::jsonb)`,
  );
  await harness.db.execute(
    sql`UPDATE engagement SET return_type='1040', tax_year=2025,
        original_due_date='2026-04-15', extended_due_date='2026-10-15' WHERE id = ${engagementId}`,
  );
  const tc = await harness.db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps, is_active)
        VALUES
          (${firmId}, '1040', 'TIER_1', 'Standard', 5, 25000, 1000, true),
          (${firmId}, '1040', 'TIER_2', 'Premium', 12, 50000, 2500, true)
        RETURNING id, tier`,
  );
  const tcRows = (tc as unknown as { rows: { id: string; tier: 'TIER_1' | 'TIER_2' }[] }).rows;
  const tier1 = tcRows.find((r) => r.tier === 'TIER_1')!.id;
  const tier2 = tcRows.find((r) => r.tier === 'TIER_2')!.id;
  const srcInv = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                             issue_date, due_date, subtotal_cents, total_cents, paid_cents, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'TAX-001', '2026-04-15', '2026-05-15',
                150000, 150000, 0, 'SENT')
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
  return (offer as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

describe('staff retainer offers list', () => {
  it('returns offers enriched with client name + portal link', async () => {
    const offerId = await seedOffer();
    const app = buildApp();
    const res = await request(app).get('/api/staff/retainers/offers');
    expect(res.status).toBe(200);
    const item = (res.body.items as Array<Record<string, unknown>>).find((i) => i.id === offerId);
    expect(item).toBeTruthy();
    expect(item!.clientName).toBe('Test Client Co');
    expect(item!.portalUrl).toBe(`${PORTAL_BASE}/retainer-offers/${offerId}`);
    expect(item!.tier1PriceCents).toBe(40000);
    expect(item!.tier2PriceCents).toBe(87500);
    expect(item!.status).toBe('pending');
  });

  it('staff in-office select creates the retainer invoice + flips to pending_payment', async () => {
    const offerId = await seedOffer();
    const app = buildApp();
    const sel = await request(app)
      .post(`/api/staff/retainers/offers/${offerId}/select`)
      .send({ tier: 'TIER_1' });
    expect(sel.status).toBe(201);
    expect(typeof sel.body.invoiceId).toBe('string');
    expect(sel.body.priceCents).toBe(40000);

    const after = await request(app).get('/api/staff/retainers/offers');
    const item = (after.body.items as Array<Record<string, unknown>>).find((i) => i.id === offerId);
    expect(item!.status).toBe('pending_payment');
    expect(item!.purchasedTier).toBe('TIER_1');
    expect(item!.purchasedInvoiceId).toBe(sel.body.invoiceId);
  });
});
