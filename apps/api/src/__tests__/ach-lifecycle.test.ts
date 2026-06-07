// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Phase 22 — ACH return reactions: record the return and apply NACHA-correct
// side effects (invalidate mandate, block PM, pause autopay schedules).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { achReturns, paymentMandates, paymentMethod, recurringBillingPlans } from '@vibe/db/schema';
import { recordAchReturnAndReact } from '../payments/ach-lifecycle';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

const STRIPE_PM = 'pm_test_bank_123';

async function seedAchOnFile(): Promise<{
  firmId: string;
  clientId: string;
  pmId: string;
  planId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId } = seed;

  // A portal identity owns the saved bank method; create a minimal identity.
  const idRows = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, preferred_method, status)
        VALUES (${firmId}, 'Payer', 'EMAIL', 'ACTIVE') RETURNING id`,
  );
  const identityId = (idRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  const pmRows = await harness.db.execute(
    sql`INSERT INTO payment_method
          (portal_identity_id, kind, provider, provider_token, last_four, display_label,
           is_default, status)
        VALUES (${identityId}, 'ACH', 'STRIPE', ${STRIPE_PM}, '6789', 'Bank ····6789',
                true, 'ACTIVE')
        RETURNING id`,
  );
  const pmId = (pmRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // Active mandate bound to the same Stripe PM.
  await harness.db.execute(
    sql`INSERT INTO payment_mandates
          (firm_id, client_id, payment_method_id, kind, stripe_account_id, stripe_payment_method_id,
           mandate_text_rendered, mandate_text_hash, state)
        VALUES (${firmId}, ${clientId}, ${pmId}, 'ACH', 'acct_test', ${STRIPE_PM},
                'I authorize…', ${'a'.repeat(64)}, 'ACTIVE')`,
  );

  // Active autopay plan drafting against that method (no firm/client cols).
  const planRows = await harness.db.execute(
    sql`INSERT INTO recurring_billing_plan
          (engagement_id, frequency, amount_cents, next_run_date, proration_rule, status,
           auto_pay_flag, auto_pay_payment_method_id)
        VALUES (${engagementId}, 'MONTHLY', 100000, '2026-05-01', 'DAILY', 'ACTIVE',
                true, ${pmId})
        RETURNING id`,
  );
  const planId = (planRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  return { firmId, clientId, pmId, planId };
}

describe('recordAchReturnAndReact', () => {
  it('R01 (NSF) records a retriable return and pauses nothing', async () => {
    const s = await seedAchOnFile();
    const r = await recordAchReturnAndReact(harness.db, {
      firmId: s.firmId,
      returnCode: 'R01',
      stripePaymentMethodId: STRIPE_PM,
    });
    expect(r.classification.retriable).toBe(true);
    expect(r.mandateInvalidated).toBe(false);
    expect(r.plansPaused).toBe(0);

    const [mandate] = await harness.db.select().from(paymentMandates);
    expect(mandate!.state).toBe('ACTIVE');
    const [plan] = await harness.db.select().from(recurringBillingPlans);
    expect(plan!.status).toBe('ACTIVE');
    const [ret] = await harness.db.select().from(achReturns);
    expect(ret!.returnCode).toBe('R01');
  });

  it('R10 (no auth) invalidates the mandate and pauses the autopay plan', async () => {
    const s = await seedAchOnFile();
    const r = await recordAchReturnAndReact(harness.db, {
      firmId: s.firmId,
      returnCode: 'R10',
      stripePaymentMethodId: STRIPE_PM,
    });
    expect(r.mandateInvalidated).toBe(true);
    expect(r.plansPaused).toBe(1);

    const [mandate] = await harness.db.select().from(paymentMandates);
    expect(mandate!.state).toBe('INVALID');
    const [plan] = await harness.db.select().from(recurringBillingPlans);
    expect(plan!.status).toBe('PAUSED');
    const [pm] = await harness.db.select().from(paymentMethod).where(eq(paymentMethod.id, s.pmId));
    expect(pm!.status).toBe('ACTIVE'); // no-auth doesn't block the account itself
  });

  it('account_closed (Stripe string) blocks the payment method too', async () => {
    const s = await seedAchOnFile();
    const r = await recordAchReturnAndReact(harness.db, {
      firmId: s.firmId,
      returnCode: 'account_closed',
      stripePaymentMethodId: STRIPE_PM,
    });
    expect(r.classification.category).toBe('ACCOUNT_ERROR');
    expect(r.paymentMethodBlocked).toBe(true);
    expect(r.plansPaused).toBe(1);
    const [pm] = await harness.db.select().from(paymentMethod).where(eq(paymentMethod.id, s.pmId));
    expect(pm!.status).toBe('REVOKED');
  });
});
