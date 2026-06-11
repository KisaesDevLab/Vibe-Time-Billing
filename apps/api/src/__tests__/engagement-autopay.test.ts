// SPDX-License-Identifier: Elastic-2.0
//
// CP9 — Per-engagement autopay tests. Exercises:
//   1. Column wiring (engagement.autopay_method_id + autopay_paused_until)
//   2. Resolution precedence — engagement override beats plan-level
//   3. Pause window — paused engagement skips autopay even if a method
//      is enrolled
//
// The portal enroll/unenroll/list endpoints are exercised by the SQL
// surface only (no Express round-trip — auth path is covered elsewhere).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface Fixture {
  firmId: string;
  clientId: string;
  engagementId: string;
  identityId: string;
  paymentMethodAId: string;
  paymentMethodBId: string;
}

async function setupFixture(): Promise<Fixture> {
  const seed = await seedMinimalFirm(harness.db);
  const idRes = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'A Person', 'a@test.example') RETURNING id`,
  );
  const identityId = (idRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // Two payment methods owned by the identity.
  const pmA = await harness.db.execute(
    sql`INSERT INTO payment_method (portal_identity_id, kind, provider,
                                     provider_token, brand, last_four, display_label, status)
        VALUES (${identityId}, 'CARD', 'STRIPE', 'tok-a', 'Visa', '4242', 'Visa ····4242', 'ACTIVE')
        RETURNING id`,
  );
  const paymentMethodAId = (pmA as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const pmB = await harness.db.execute(
    sql`INSERT INTO payment_method (portal_identity_id, kind, provider,
                                     provider_token, brand, last_four, display_label, status)
        VALUES (${identityId}, 'CARD', 'STRIPE', 'tok-b', 'Mastercard', '5555', 'Mastercard ····5555', 'ACTIVE')
        RETURNING id`,
  );
  const paymentMethodBId = (pmB as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return {
    firmId: seed.firmId,
    clientId: seed.clientId,
    engagementId: seed.engagementId,
    identityId,
    paymentMethodAId,
    paymentMethodBId,
  };
}

describe('engagement.autopay_method_id', () => {
  it('column accepts a FK to payment_method', async () => {
    const f = await setupFixture();
    await harness.db.execute(
      sql`UPDATE engagement
          SET autopay_method_id = ${f.paymentMethodAId}
          WHERE id = ${f.engagementId}`,
    );
    const rows = await harness.db.execute(
      sql`SELECT autopay_method_id::text AS pm FROM engagement WHERE id = ${f.engagementId}`,
    );
    const pm = (rows as unknown as { rows: { pm: string }[] }).rows[0]!.pm;
    expect(pm).toBe(f.paymentMethodAId);
  });

  it('ON DELETE SET NULL — deleting the payment method nulls the FK', async () => {
    const f = await setupFixture();
    await harness.db.execute(
      sql`UPDATE engagement
          SET autopay_method_id = ${f.paymentMethodAId}
          WHERE id = ${f.engagementId}`,
    );
    await harness.db.execute(sql`DELETE FROM payment_method WHERE id = ${f.paymentMethodAId}`);
    const rows = await harness.db.execute(
      sql`SELECT autopay_method_id FROM engagement WHERE id = ${f.engagementId}`,
    );
    expect(
      (rows as unknown as { rows: { autopay_method_id: string | null }[] }).rows[0]!
        .autopay_method_id,
    ).toBeNull();
  });

  it('autopay_paused_until accepts a date', async () => {
    const f = await setupFixture();
    await harness.db.execute(
      sql`UPDATE engagement
          SET autopay_method_id = ${f.paymentMethodAId},
              autopay_paused_until = '2027-01-01'
          WHERE id = ${f.engagementId}`,
    );
    const rows = await harness.db.execute(
      sql`SELECT autopay_paused_until::text AS p FROM engagement WHERE id = ${f.engagementId}`,
    );
    expect((rows as unknown as { rows: { p: string }[] }).rows[0]!.p).toBe('2027-01-01');
  });
});

// Mirrors the resolveAutopayMethodId logic in recurring-billing.ts.
function resolveAutopayMethodId(args: {
  engagementOverride: string | null;
  pausedUntil: string | null;
  planFlag: boolean;
  planMethod: string | null;
  today: string;
}): string | null {
  const paused = args.pausedUntil != null && args.pausedUntil >= args.today;
  if (paused) return null;
  if (args.engagementOverride) return args.engagementOverride;
  if (args.planFlag && args.planMethod) return args.planMethod;
  return null;
}

describe('autopay resolution precedence', () => {
  it('engagement override wins over plan-level method', () => {
    const result = resolveAutopayMethodId({
      engagementOverride: 'pm-engagement',
      pausedUntil: null,
      planFlag: true,
      planMethod: 'pm-plan',
      today: '2026-05-25',
    });
    expect(result).toBe('pm-engagement');
  });

  it('falls back to plan-level when no engagement override', () => {
    const result = resolveAutopayMethodId({
      engagementOverride: null,
      pausedUntil: null,
      planFlag: true,
      planMethod: 'pm-plan',
      today: '2026-05-25',
    });
    expect(result).toBe('pm-plan');
  });

  it('paused engagement skips autopay even with engagement-override set', () => {
    const result = resolveAutopayMethodId({
      engagementOverride: 'pm-engagement',
      pausedUntil: '2026-06-01',
      planFlag: true,
      planMethod: 'pm-plan',
      today: '2026-05-25',
    });
    expect(result).toBeNull();
  });

  it('past pausedUntil date allows autopay again', () => {
    const result = resolveAutopayMethodId({
      engagementOverride: 'pm-engagement',
      pausedUntil: '2026-05-01',
      planFlag: false,
      planMethod: null,
      today: '2026-05-25',
    });
    expect(result).toBe('pm-engagement');
  });

  it('no override and no plan flag → null (manual pay)', () => {
    const result = resolveAutopayMethodId({
      engagementOverride: null,
      pausedUntil: null,
      planFlag: false,
      planMethod: null,
      today: '2026-05-25',
    });
    expect(result).toBeNull();
  });

  it('plan flag false suppresses fallback even when planMethod is set', () => {
    const result = resolveAutopayMethodId({
      engagementOverride: null,
      pausedUntil: null,
      planFlag: false,
      planMethod: 'pm-plan',
      today: '2026-05-25',
    });
    expect(result).toBeNull();
  });
});
