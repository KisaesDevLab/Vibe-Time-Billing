// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0158 — Payments → Import tab API: CSV preview matching (client by
// external_id→aws_id, ACTIVE engagement of the chosen type, unbilled
// WIP, duplicate probe) + import header/row logging.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql, eq, and } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';
import { paymentMethodTypes } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPaymentImportRouter } from '../payments/import-routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

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
  const fakeUserRoles = new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]);
  app.use(
    '/api/staff/payment-imports',
    createPaymentImportRouter({ db: harness.db, fakeUserRoles }),
  );
  return app;
}

async function one(q: string): Promise<string> {
  const r = await harness.db.execute(sql.raw(q));
  return (r as unknown as { rows: { id: string }[] }).rows[0]!.id;
}

/** Payroll type + the seed engagement linked to it; seed client coded. */
async function seedPayrollWorld(): Promise<{ typeId: string }> {
  const typeId = await one(
    `INSERT INTO engagement_type (firm_id, key, name) VALUES ('${seed.firmId}', 'payroll_services', 'Payroll Services') RETURNING id`,
  );
  await harness.db.execute(
    sql.raw(
      `UPDATE engagement SET engagement_type_id = '${typeId}', status = 'ACTIVE' WHERE id = '${seed.engagementId}'`,
    ),
  );
  await harness.db.execute(
    sql.raw(`UPDATE client SET external_id = 'AMER0667' WHERE id = '${seed.clientId}'`),
  );
  return { typeId };
}

async function seedTime(amountCents: number): Promise<void> {
  await harness.db.execute(
    sql.raw(
      `INSERT INTO time_entry (engagement_id, app_user_id, work_code_id, entry_date, hours,
         standard_rate_snapshot_cents, standard_amount_cents, in_scope_flag, description, status)
       VALUES ('${seed.engagementId}', '${seed.appUserId}', '${seed.workCodeId}', '2026-06-01',
         '1.00', ${amountCents}, ${amountCents}, false, 'payroll run', 'SUBMITTED')`,
    ),
  );
}

const CSV = `Client Code, Client Name,Charge Date,Description,Amount
"AMER0667","American Western Bonding","06/12/2026","Payroll Number 25 (6/11/2026)",82.6500
"AMER0667","American Western Bonding","06/12/2026","Payroll Number 26 (6/11/2026)",17.3500
"BASS0993","Bass Equipment Company","06/12/2026","Payroll Number 25 (6/11/2026)",189.0000
"NOPE0000","Unknown Client","06/12/2026","Payroll Number 1 (6/11/2026)",10.0000
`;

describe('payment import preview', () => {
  it('matches clients/engagements, sums WIP vs billed, flags unmatched', async () => {
    const { typeId } = await seedPayrollWorld();
    await seedTime(5000); // $50 unbilled WIP
    // BASS — client exists (by aws_id) but has no payroll engagement.
    await one(
      `INSERT INTO client (firm_id, name, aws_id, partner_in_charge_id, office_id)
       SELECT '${seed.firmId}', 'Bass Equipment Company', 'BASS0993', '${seed.appUserId}', office_id
       FROM client WHERE id = '${seed.clientId}' RETURNING id`,
    );

    const app = buildApp();
    const res = await request(app)
      .post('/api/staff/payment-imports/preview')
      .send({ csv: CSV, engagementTypeId: typeId });
    expect(res.status).toBe(200);
    interface AnyGroup {
      clientCode: string;
      plan: string;
      client: { name: string } | null;
      wipCents: number;
      targetCents: number;
      adjustmentCents: number;
      engagementId: string | null;
      rows: unknown[];
      maxChargeDate: string;
    }
    const byCode = new Map((res.body.groups as AnyGroup[]).map((g) => [g.clientCode, g]));

    const amer = byCode.get('AMER0667')!;
    expect(amer.plan).toBe('BILL_AND_PAY');
    expect(amer.engagementId).toBe(seed.engagementId);
    expect(amer.wipCents).toBe(5000);
    expect(amer.targetCents).toBe(8265 + 1735); // both lines
    expect(amer.adjustmentCents).toBe(10000 - 5000);
    expect(amer.rows).toHaveLength(2);
    expect(amer.maxChargeDate).toBe('2026-06-12');

    const bass = byCode.get('BASS0993')!;
    expect(bass.plan).toBe('PREPAYMENT'); // matched via aws_id, no engagement
    expect(bass.client?.name).toBe('Bass Equipment Company');

    const nope = byCode.get('NOPE0000')!;
    expect(nope.plan).toBe('UNMATCHED');
    expect(nope.client).toBeNull();
  });

  it('engagement with zero unbilled time plans as PREPAYMENT', async () => {
    const { typeId } = await seedPayrollWorld();
    const app = buildApp();
    const res = await request(app)
      .post('/api/staff/payment-imports/preview')
      .send({ csv: CSV, engagementTypeId: typeId });
    const amer = (res.body.groups as { clientCode: string; plan: string }[]).find(
      (g) => g.clientCode === 'AMER0667',
    )!;
    expect(amer.plan).toBe('PREPAYMENT');
  });

  it('workflow-COMPLETED / CANCELED engagements are excluded from matching', async () => {
    const { typeId } = await seedPayrollWorld();
    await seedTime(5000);
    await harness.db.execute(
      sql.raw(
        `UPDATE engagement SET workflow_state = 'COMPLETED' WHERE id = '${seed.engagementId}'`,
      ),
    );
    const app = buildApp();
    const res = await request(app)
      .post('/api/staff/payment-imports/preview')
      .send({ csv: CSV, engagementTypeId: typeId });
    const amer = (
      res.body.groups as { clientCode: string; plan: string; engagements: unknown[] }[]
    ).find((g) => g.clientCode === 'AMER0667')!;
    expect(amer.plan).toBe('PREPAYMENT'); // despite unbilled time existing
    expect(amer.engagements).toHaveLength(0);
  });

  it('two active engagements of the type → PICK_ENGAGEMENT with candidates', async () => {
    const { typeId } = await seedPayrollWorld();
    await one(
      `INSERT INTO engagement (client_id, name, fee_structure, engagement_type_id, status)
       VALUES ('${seed.clientId}', 'Payroll 2', 'HOURLY', '${typeId}', 'ACTIVE') RETURNING id`,
    );
    const app = buildApp();
    const res = await request(app)
      .post('/api/staff/payment-imports/preview')
      .send({ csv: CSV, engagementTypeId: typeId });
    const amer = (
      res.body.groups as { clientCode: string; plan: string; engagements: unknown[] }[]
    ).find((g) => g.clientCode === 'AMER0667')!;
    expect(amer.plan).toBe('PICK_ENGAGEMENT');
    expect(amer.engagements).toHaveLength(2);
  });
});

describe('payment import header + row log + dedupe', () => {
  it('creates the header (seeding the method), logs rows, then flags duplicates', async () => {
    const { typeId } = await seedPayrollWorld();
    await seedTime(5000);
    const app = buildApp();

    const created = await request(app).post('/api/staff/payment-imports').send({
      engagementTypeId: typeId,
      paymentMethodKey: 'PAYROLL_DRAFT',
      paymentMethodLabel: 'Payroll draft',
      fileName: 'charges.csv',
    });
    expect(created.status).toBe(201);
    const importId = created.body.id as string;

    // The payment-method catalog gained the key (idempotently).
    const [method] = await harness.db
      .select()
      .from(paymentMethodTypes)
      .where(
        and(
          eq(paymentMethodTypes.firmId, seed.firmId),
          eq(paymentMethodTypes.key, 'PAYROLL_DRAFT'),
        ),
      );
    expect(method?.active).toBe(true);
    const again = await request(app).post('/api/staff/payment-imports').send({
      engagementTypeId: typeId,
      paymentMethodKey: 'PAYROLL_DRAFT',
    });
    expect(again.status).toBe(201); // no unique violation

    const logged = await request(app)
      .post(`/api/staff/payment-imports/${importId}/rows`)
      .send({
        rows: [
          {
            clientCode: 'AMER0667',
            clientName: 'American Western Bonding',
            // Different charge date than the CSV — dedupe keys on
            // client + description + amount, not the date.
            chargeDate: '2026-06-11',
            description: 'Payroll Number 25 (6/11/2026)',
            amountCents: 8265,
            clientId: seed.clientId,
            engagementId: seed.engagementId,
            outcome: 'INVOICED_PAID',
          },
        ],
      });
    expect(logged.status).toBe(201);

    // Re-preview: line 25 is now a duplicate; line 26 is still live.
    const res = await request(app)
      .post('/api/staff/payment-imports/preview')
      .send({ csv: CSV, engagementTypeId: typeId });
    const amer = (
      res.body.groups as {
        clientCode: string;
        targetCents: number;
        rows: { duplicate: boolean; description: string }[];
      }[]
    ).find((g) => g.clientCode === 'AMER0667')!;
    expect(amer.rows.find((r) => r.description.includes('Number 25'))!.duplicate).toBe(true);
    expect(amer.rows.find((r) => r.description.includes('Number 26'))!.duplicate).toBe(false);
    expect(amer.targetCents).toBe(1735); // only the live line

    // History endpoints.
    const list = await request(app).get('/api/staff/payment-imports');
    expect(list.body.items).toHaveLength(2);
    const detail = await request(app).get(`/api/staff/payment-imports/${importId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.rows).toHaveLength(1);
  });
});
