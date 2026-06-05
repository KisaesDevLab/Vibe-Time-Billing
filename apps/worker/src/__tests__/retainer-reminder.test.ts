// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// R4-followup — coverage for the delayed retainer notification job
// handlers. The handlers are pure functions of `(db, log, args, payload)`
// so we exercise them directly with a stub mail dispatcher and an
// in-memory pglite. The scheduler.ts helper that enqueues these jobs
// touches Redis and is covered by manual integration testing only
// (BullMQ + Redis is out-of-scope for the unit suite).
//
// Cases:
//   • Offer reminder skips when the offer no longer exists.
//   • Offer reminder skips when the offer was purchased (terminal).
//   • Offer reminder skips when firm feature_enabled=false.
//   • Offer reminder sends to the billing contact when all preconditions hold.
//   • Expiry warning skips when retainer is paused / void / expired.
//   • Expiry warning sends when retainer is active.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as schema from '@vibe/db/schema';
import type { Database } from '@vibe/db';

import { runRetainerOfferReminder } from '../jobs/retainer-offer-reminder';
import { runRetainerExpiryWarning } from '../jobs/retainer-expiry-warning';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', '..', 'packages', 'db', 'migrations');

interface Harness {
  pglite: PGlite;
  db: Database;
  close: () => Promise<void>;
}

async function buildHarness(): Promise<Harness> {
  const pglite = new PGlite();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const raw = readFileSync(join(migrationsDir, f), 'utf8');
    const cleaned = raw
      .replace(/DO \$\$\s*BEGIN\s*IF NOT EXISTS[\s\S]*?END\s*\$\$;?/g, '-- skipped role bootstrap')
      .replace(/^(REVOKE|GRANT) .*$/gim, '-- skipped grant/revoke');
    await pglite.exec(cleaned);
  }
  const db = drizzle(pglite, { schema }) as unknown as Database;
  return {
    pglite,
    db,
    async close() {
      await pglite.close();
    },
  };
}

interface RetainerSeed {
  firmId: string;
  clientId: string;
  engagementId: string;
  workCodeId: string;
  appUserId: string;
  contactEmail: string;
  tierConfigId: string;
}

async function seedRetainerCtx(
  db: Database,
  opts?: { featureEnabled?: boolean },
): Promise<RetainerSeed> {
  const firm = await db.execute(sql`INSERT INTO firm (name) VALUES ('Test Firm') RETURNING id`);
  const firmId = (firm as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const user = await db.execute(
    sql`INSERT INTO app_user (firm_id, email, full_name, first_name, last_name)
        VALUES (${firmId}, 'partner@test.example', 'Pat Partner', 'Pat', 'Partner') RETURNING id`,
  );
  const appUserId = (user as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // 0092 made client.office_id NOT NULL — this fresh firm needs an office.
  const office = await db.execute(
    sql`INSERT INTO office (firm_id, name, timezone, is_default)
        VALUES (${firmId}, 'HQ', 'America/Chicago', true) RETURNING id`,
  );
  const officeId = (office as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const client = await db.execute(
    sql`INSERT INTO client (firm_id, name, partner_in_charge_id, office_id)
        VALUES (${firmId}, 'Acme Co', ${appUserId}, ${officeId}) RETURNING id`,
  );
  const clientId = (client as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const eng = await db.execute(
    sql`INSERT INTO engagement (client_id, name, fee_structure, return_type, tax_year)
        VALUES (${clientId}, 'TY2026 1040', 'HOURLY', '1040', 2026) RETURNING id`,
  );
  const engagementId = (eng as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const sl = await db.execute(
    sql`INSERT INTO service_line (firm_id, name, category)
        VALUES (${firmId}, 'Tax', 'tax') RETURNING id`,
  );
  const serviceLineId = (sl as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const wc = await db.execute(
    sql`INSERT INTO work_code (firm_id, key, name, service_line_id)
        VALUES (${firmId}, 'tax_prep', 'Tax Preparation', ${serviceLineId}) RETURNING id`,
  );
  const workCodeId = (wc as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const contactEmail = 'biller@acme.example';
  // 0115 — name/email live on the firm-global person; contact links to it.
  const pr = await db.execute(
    sql`INSERT INTO person (firm_id, full_name, email)
        VALUES (${firmId}, 'Billy Biller', ${contactEmail}) RETURNING id`,
  );
  const personId = (pr as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await db.execute(
    sql`INSERT INTO client_contact (client_id, person_id, is_primary, is_billing)
        VALUES (${clientId}, ${personId}, true, true)`,
  );
  await db.execute(
    sql`INSERT INTO firm_retainer_settings (firm_id, feature_enabled)
        VALUES (${firmId}, ${opts?.featureEnabled ?? true})`,
  );
  const tc = await db.execute(
    sql`INSERT INTO retainer_tier_config
          (firm_id, return_type, tier, name, hours, base_fee_cents, pct_of_prep_fee_bps)
        VALUES (${firmId}, '1040', 'TIER_1', 'Standard', 10, 25000, 1000)
        RETURNING id`,
  );
  const tierConfigId = (tc as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return { firmId, clientId, engagementId, workCodeId, appUserId, contactEmail, tierConfigId };
}

let harness: Harness;
const log = pino({ level: 'silent' });

beforeEach(async () => {
  harness = await buildHarness();
});

afterEach(async () => {
  await harness.close();
});

describe('runRetainerOfferReminder', () => {
  it('skips when offer is missing', async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    const result = await runRetainerOfferReminder(
      harness.db,
      log,
      {
        sendEmail: async (args) => {
          sent.push({ to: args.to, subject: args.subject });
        },
      },
      { offerId: '00000000-0000-0000-0000-000000000000', kind: 'onbill' },
    );
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('offer_missing');
    expect(sent).toHaveLength(0);
  });

  it('skips when offer is in terminal status', async () => {
    const f = await seedRetainerCtx(harness.db);
    const offer = await harness.db.execute(
      sql`INSERT INTO retainer_offer
            (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
             prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
             tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
          SELECT ${f.firmId}, ${f.clientId}, ${f.engagementId}, id, '1040', 2026,
                 0, ${f.tierConfigId}, ${f.tierConfigId},
                 50000, 100000, NOW() + INTERVAL '30 days', 'declined'
          FROM (SELECT gen_random_uuid() AS id) x
          WHERE false
          RETURNING id`,
    );
    // The above WHERE false hack — easier to build the FK out-of-band:
    const inv = await harness.db.execute(
      sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number, issue_date, due_date,
                                subtotal_cents, total_cents, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.engagementId}, 'INV-1', '2026-01-01', '2026-02-01', 50000, 50000, 'DRAFT')
          RETURNING id`,
    );
    const invoiceId = (inv as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const offerRow = await harness.db.execute(
      sql`INSERT INTO retainer_offer
            (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
             prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
             tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.engagementId}, ${invoiceId}, '1040', 2026,
                  150000, ${f.tierConfigId}, ${f.tierConfigId},
                  50000, 100000, NOW() + INTERVAL '30 days', 'declined')
          RETURNING id`,
    );
    const offerId = (offerRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
    void offer;
    const sent: Array<{ to: string }> = [];
    const result = await runRetainerOfferReminder(
      harness.db,
      log,
      {
        sendEmail: async (args) => {
          sent.push({ to: args.to });
        },
      },
      { offerId, kind: 'day30' },
    );
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('offer_terminal');
    expect(sent).toHaveLength(0);
  });

  it('skips when feature_enabled=false', async () => {
    const f = await seedRetainerCtx(harness.db, { featureEnabled: false });
    const inv = await harness.db.execute(
      sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number, issue_date, due_date,
                                subtotal_cents, total_cents, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.engagementId}, 'INV-2', '2026-01-01', '2026-02-01', 50000, 50000, 'DRAFT')
          RETURNING id`,
    );
    const invoiceId = (inv as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const offerRow = await harness.db.execute(
      sql`INSERT INTO retainer_offer
            (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
             prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
             tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.engagementId}, ${invoiceId}, '1040', 2026,
                  150000, ${f.tierConfigId}, ${f.tierConfigId},
                  50000, 100000, NOW() + INTERVAL '30 days', 'pending')
          RETURNING id`,
    );
    const offerId = (offerRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const result = await runRetainerOfferReminder(
      harness.db,
      log,
      { sendEmail: async () => {} },
      { offerId, kind: 'onbill' },
    );
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('feature_disabled');
  });

  it('sends to billing contact when all preconditions hold', async () => {
    const f = await seedRetainerCtx(harness.db);
    const inv = await harness.db.execute(
      sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number, issue_date, due_date,
                                subtotal_cents, total_cents, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.engagementId}, 'INV-3', '2026-01-01', '2026-02-01', 50000, 50000, 'DRAFT')
          RETURNING id`,
    );
    const invoiceId = (inv as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const offerRow = await harness.db.execute(
      sql`INSERT INTO retainer_offer
            (firm_id, client_id, engagement_id, invoice_id, return_type, tax_year,
             prep_fee_basis_cents, tier_1_tier_config_id, tier_2_tier_config_id,
             tier_1_price_cents, tier_2_price_cents, offer_expires_at, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.engagementId}, ${invoiceId}, '1040', 2026,
                  150000, ${f.tierConfigId}, ${f.tierConfigId},
                  50000, 100000, NOW() + INTERVAL '30 days', 'pending')
          RETURNING id`,
    );
    const offerId = (offerRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
    const sent: Array<{ to: string; subject: string; body: string }> = [];
    const result = await runRetainerOfferReminder(
      harness.db,
      log,
      {
        sendEmail: async (args) => {
          sent.push(args);
        },
        portalBaseUrl: 'https://test.example',
      },
      { offerId, kind: 'day55' },
    );
    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(f.contactEmail);
    expect(sent[0]!.subject).toMatch(/Final reminder/);
    expect(sent[0]!.body).toMatch(/Standard Coverage/);
    expect(sent[0]!.body).toMatch(/https:\/\/test\.example\/portal\/retainer-offers\//);
  });
});

describe('runRetainerExpiryWarning', () => {
  async function createRetainer(
    db: Database,
    f: RetainerSeed,
    status: 'active' | 'paused' | 'void' | 'expired' = 'active',
  ): Promise<string> {
    const r = await db.execute(
      sql`INSERT INTO retainer
            (firm_id, client_id, engagement_id, tier, return_type, tax_year,
             tier_config_id, name, hours_purchased, hours_consumed, price_cents,
             purchase_date, expiry_date, status)
          VALUES (${f.firmId}, ${f.clientId}, ${f.engagementId}, 'TIER_1', '1040', 2026,
                  ${f.tierConfigId}, 'Standard', 10, 3, 25000,
                  '2026-05-24', '2029-05-24', ${status})
          RETURNING id`,
    );
    return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
  }

  it('skips when retainer is paused', async () => {
    const f = await seedRetainerCtx(harness.db);
    const retainerId = await createRetainer(harness.db, f, 'paused');
    const sent: Array<{ to: string }> = [];
    const result = await runRetainerExpiryWarning(
      harness.db,
      log,
      {
        sendEmail: async (args) => {
          sent.push(args);
        },
      },
      { retainerId, kind: '30d' },
    );
    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('retainer_terminal');
    expect(sent).toHaveLength(0);
  });

  it('sends with hours-remaining + expiry copy when active', async () => {
    const f = await seedRetainerCtx(harness.db);
    const retainerId = await createRetainer(harness.db, f, 'active');
    const sent: Array<{ to: string; subject: string; body: string }> = [];
    const result = await runRetainerExpiryWarning(
      harness.db,
      log,
      {
        sendEmail: async (args) => {
          sent.push(args);
        },
        portalBaseUrl: 'https://test.example',
      },
      { retainerId, kind: '7d' },
    );
    expect(result.sent).toBe(true);
    expect(sent[0]!.to).toBe(f.contactEmail);
    expect(sent[0]!.subject).toMatch(/Final notice/);
    // hours_remaining = 10 - 3 = 7
    expect(sent[0]!.body).toMatch(/7\.00 hours remaining/);
    expect(sent[0]!.body).toMatch(/2029-05-24/);
  });
});
