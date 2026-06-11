// SPDX-License-Identifier: Elastic-2.0
//
// Staff retainer offer actions: delete a PENDING offer (409 once it's no
// longer pending) and email the proposal link to the client's primary
// contact (422 when there's no primary contact with an email).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createRetainerRouter } from '../retainers/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

const PORTAL_BASE = 'https://portal.firm.example';
let mailbox: Array<{ to: string; subject: string; body: string }>;

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
      sendStaffMail: async (a) => {
        mailbox.push({ to: a.to, subject: a.subject, body: a.body });
      },
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
  mailbox = [];
});
afterEach(async () => {
  await harness.close();
});

describe('retainer offer delete', () => {
  it('deletes a pending offer', async () => {
    const offerId = await seedOffer();
    const app = buildApp();
    const del = await request(app).delete(`/api/staff/retainers/offers/${offerId}`);
    expect(del.status).toBe(200);
    const after = await request(app).get('/api/staff/retainers/offers');
    expect((after.body.items as Array<{ id: string }>).some((i) => i.id === offerId)).toBe(false);
  });

  it('409s when the offer is no longer pending', async () => {
    const offerId = await seedOffer();
    const app = buildApp();
    await request(app)
      .post(`/api/staff/retainers/offers/${offerId}/select`)
      .send({ tier: 'TIER_1' });
    const del = await request(app).delete(`/api/staff/retainers/offers/${offerId}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('offer_not_pending');
  });
});

describe('retainer offer email proposal', () => {
  it('emails the portal link to the client primary contact', async () => {
    const offerId = await seedOffer();
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Pat Primary',
      email: 'pat@client.example',
      isPrimary: true,
    });
    const app = buildApp();
    const res = await request(app).post(`/api/staff/retainers/offers/${offerId}/email`).send({});
    expect(res.status).toBe(200);
    expect(res.body.to).toBe('pat@client.example');
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]!.to).toBe('pat@client.example');
    expect(mailbox[0]!.body).toContain(`${PORTAL_BASE}/retainer-offers/${offerId}`);
  });

  it('422s when there is no primary contact with an email', async () => {
    const offerId = await seedOffer();
    const app = buildApp();
    const res = await request(app).post(`/api/staff/retainers/offers/${offerId}/email`).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_primary_contact_email');
    expect(mailbox).toHaveLength(0);
  });
});
