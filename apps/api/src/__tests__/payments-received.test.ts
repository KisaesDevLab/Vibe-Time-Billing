// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Billing → Payments listing endpoint: channel derivation, summary math
// (gross = succeeded only, fees, net, refunds, pending count), channel filter.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPaymentRouter } from '../payments/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

interface Res {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): Res;
  json(b: unknown): Res;
}
function makeRes(): Res {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}
async function get(
  router: ReturnType<typeof createPaymentRouter>,
  firmId: string,
  appUserId: string,
  query: Record<string, string>,
): Promise<Res> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === '/received' && r.methods['get'] === true;
  });
  if (!layer) throw new Error('route not found');
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(
    { staffSession: { firmId, appUserId }, query, ip: '127.0.0.1', get: () => undefined },
    res,
  );
  return res;
}

async function seed(): Promise<{ firmId: string; appUserId: string }> {
  const s = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId, appUserId } = s;
  const invRows = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                             issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'INV-1', '2026-06-01', '2026-06-15',
                500000, 500000, 'PARTIALLY_PAID') RETURNING id`,
  );
  const invoiceId = (invRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // Saved card method for a STRIPE card payment.
  const idRows = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, preferred_method, status)
        VALUES (${firmId}, 'Payer', 'EMAIL', 'ACTIVE') RETURNING id`,
  );
  const identityId = (idRows as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const cardRows = await harness.db.execute(
    sql`INSERT INTO payment_method (portal_identity_id, kind, provider, provider_token,
                                    last_four, display_label, is_default, status)
        VALUES (${identityId}, 'CARD', 'STRIPE', 'pm_card', '4242', 'Visa', true, 'ACTIVE')
        RETURNING id`,
  );
  const cardPmId = (cardRows as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const achRows = await harness.db.execute(
    sql`INSERT INTO payment_method (portal_identity_id, kind, provider, provider_token,
                                    last_four, display_label, is_default, status)
        VALUES (${identityId}, 'ACH', 'STRIPE', 'pm_ach', '6789', 'Bank', false, 'ACTIVE')
        RETURNING id`,
  );
  const achPmId = (achRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  // Manual check receipt.
  const rcptRows = await harness.db.execute(
    sql`INSERT INTO payment_receipt (firm_id, payer_client_id, payment_date, payment_method,
                                     mode, total_cents, provider, status)
        VALUES (${firmId}, ${clientId}, '2026-06-05', 'CHECK', 'RECORD', 45000, 'MANUAL', 'SUCCEEDED')
        RETURNING id`,
  );
  const receiptId = (rcptRows as unknown as { rows: { id: string }[] }).rows[0]!.id;

  await harness.db.execute(
    sql`INSERT INTO payment (invoice_id, amount_cents, fee_cents, provider, status, received_at,
                             payment_method_id)
        VALUES (${invoiceId}, 120000, 3500, 'STRIPE', 'SUCCEEDED', '2026-06-07T10:00:00Z', ${cardPmId})`,
  );
  await harness.db.execute(
    sql`INSERT INTO payment (invoice_id, amount_cents, fee_cents, provider, status, received_at,
                             receipt_id)
        VALUES (${invoiceId}, 45000, 0, 'MANUAL', 'SUCCEEDED', '2026-06-06T10:00:00Z', ${receiptId})`,
  );
  await harness.db.execute(
    sql`INSERT INTO payment (invoice_id, amount_cents, fee_cents, provider, status, received_at,
                             payment_method_id)
        VALUES (${invoiceId}, 300000, 500, 'STRIPE', 'PENDING', '2026-06-06T11:00:00Z', ${achPmId})`,
  );
  return { firmId, appUserId };
}

function router() {
  return createPaymentRouter({ db: harness.db, stripe: null, fakeUserRoles: undefined });
}

interface Body {
  items: { channel: string; status: string; netCents: number }[];
  summary: {
    count: number;
    grossCents: number;
    feesCents: number;
    netCents: number;
    refundsCents: number;
    pendingCount: number;
  };
}

describe('GET /payments/received', () => {
  it('derives channels and computes the summary (gross = succeeded only)', async () => {
    const { firmId, appUserId } = await seed();
    const res = await get(router(), firmId, appUserId, {});
    const body = res.jsonBody as Body;
    expect(body.summary.count).toBe(3);
    expect(body.summary.grossCents).toBe(165000); // 120000 + 45000 (PENDING ACH excluded)
    expect(body.summary.feesCents).toBe(3500);
    expect(body.summary.netCents).toBe(161500);
    expect(body.summary.pendingCount).toBe(1);
    const channels = body.items.map((i) => i.channel).sort();
    expect(channels).toEqual(['ACH', 'Card', 'Check']);
  });

  it('filters by channel', async () => {
    const { firmId, appUserId } = await seed();
    const res = await get(router(), firmId, appUserId, { channel: 'Check' });
    const body = res.jsonBody as Body;
    expect(body.summary.count).toBe(1);
    expect(body.items[0]!.channel).toBe('Check');
  });
});
