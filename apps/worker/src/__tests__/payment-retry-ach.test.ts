// SPDX-License-Identifier: Elastic-2.0
//
// Phase 21 — the autopay retry worker honors NACHA for ACH: a no-authorization
// return (R10) is never retried; an NSF return (R01) within the cap still is.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  type PgliteHarness,
} from '../../../api/src/__tests__/_pglite-harness';
import { payments } from '@vibe/db/schema';
import { runPaymentRetry } from '../jobs/payment-retry';

let harness: PgliteHarness;
const log = pino({ level: 'silent' });

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

async function seedFailedAchPayment(returnCode: string): Promise<{ paymentId: string }> {
  const seed = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId } = seed;
  const invRows = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                             issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'INV-1', '2026-04-01', '2026-04-15',
                100000, 100000, 'SENT') RETURNING id`,
  );
  const invoiceId = (invRows as unknown as { rows: { id: string }[] }).rows[0]!.id;
  // A saved method must exist (worker skips when paymentMethodId is null).
  const idRows = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, preferred_method, status)
        VALUES (${firmId}, 'Payer', 'EMAIL', 'ACTIVE') RETURNING id`,
  );
  const identityId = (idRows as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const pmRows = await harness.db.execute(
    sql`INSERT INTO payment_method
          (portal_identity_id, kind, provider, provider_token, last_four, display_label,
           is_default, status)
        VALUES (${identityId}, 'ACH', 'STRIPE', 'pm_bank', '1111', 'Bank ····1111', true, 'ACTIVE')
        RETURNING id`,
  );
  const pmId = (pmRows as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const payRows = await harness.db.execute(
    sql`INSERT INTO payment (invoice_id, amount_cents, fee_cents, provider, payment_method_id,
                             status, received_at, retry_count, next_retry_at)
        VALUES (${invoiceId}, 100000, 0, 'STRIPE', ${pmId}, 'FAILED', now(), 0, now())
        RETURNING id`,
  );
  const paymentId = (payRows as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO ach_returns (firm_id, payment_id, invoice_id, return_code, category,
                                 retriable, source)
        VALUES (${firmId}, ${paymentId}, ${invoiceId}, ${returnCode}, 'X', false, 'failure')`,
  );
  return { paymentId };
}

describe('runPaymentRetry — NACHA ACH guard', () => {
  it('never retries a no-authorization ACH return (R10)', async () => {
    const { paymentId } = await seedFailedAchPayment('R10');
    let charged = false;
    const out = await runPaymentRetry(harness.db, log, {
      chargeInvoice: async () => {
        charged = true;
        return { ok: true, providerChargeId: 'ch_x' };
      },
    });
    expect(charged).toBe(false); // never attempted
    expect(out.gaveUp).toBe(1);
    const [pay] = await harness.db.select().from(payments).where(eq(payments.id, paymentId));
    expect(pay!.nextRetryAt).toBeNull(); // halted
    expect(pay!.status).toBe('FAILED');
  });

  it('still retries an NSF return (R01) within the cap', async () => {
    await seedFailedAchPayment('R01');
    let charged = false;
    const out = await runPaymentRetry(harness.db, log, {
      chargeInvoice: async () => {
        charged = true;
        return { ok: true, providerChargeId: 'ch_ok' };
      },
    });
    expect(charged).toBe(true);
    expect(out.succeeded).toBe(1);
  });
});
