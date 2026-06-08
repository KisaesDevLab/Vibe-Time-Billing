// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Edit + void of manually-recorded payments: recompute the invoice, exclude
// voided rows, and keep Stripe-processed payments read-only.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { invoices, payments } from '@vibe/db/schema';
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
async function call(
  router: ReturnType<typeof createPaymentRouter>,
  method: 'patch' | 'post',
  path: string,
  firmId: string,
  appUserId: string,
  params: Record<string, string>,
  body: unknown,
): Promise<Res> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (rq: unknown, rs: unknown) => Promise<void>)(
    {
      staffSession: { firmId, appUserId },
      params,
      query: {},
      body,
      ip: '127.0.0.1',
      get: () => undefined,
    },
    res,
  );
  return res;
}

async function seed(): Promise<{
  firmId: string;
  appUserId: string;
  invoiceId: string;
  manualPayId: string;
  stripePayId: string;
}> {
  const s = await seedMinimalFirm(harness.db);
  const { firmId, clientId, engagementId, appUserId } = s;
  const invRows = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                             issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'INV-1', '2026-06-01', '2026-06-15',
                100000, 100000, 'PARTIALLY_PAID') RETURNING id`,
  );
  const invoiceId = (invRows as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const m = await harness.db.execute(
    sql`INSERT INTO payment (invoice_id, amount_cents, fee_cents, provider, status, received_at)
        VALUES (${invoiceId}, 60000, 0, 'MANUAL', 'SUCCEEDED', '2026-06-05T10:00:00Z') RETURNING id`,
  );
  const manualPayId = (m as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const st = await harness.db.execute(
    sql`INSERT INTO payment (invoice_id, amount_cents, fee_cents, provider, status, received_at)
        VALUES (${invoiceId}, 40000, 1200, 'STRIPE', 'SUCCEEDED', '2026-06-06T10:00:00Z') RETURNING id`,
  );
  const stripePayId = (st as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db
    .update(invoices)
    .set({ paidCents: 100000, status: 'PAID' })
    .where(eq(invoices.id, invoiceId));
  return { firmId, appUserId, invoiceId, manualPayId, stripePayId };
}

function router() {
  return createPaymentRouter({ db: harness.db, stripe: null, fakeUserRoles: undefined });
}

describe('payment edit + void', () => {
  it('edits a manual payment amount and recomputes the invoice', async () => {
    const s = await seed();
    const res = await call(
      router(),
      'patch',
      '/:id',
      s.firmId,
      s.appUserId,
      { id: s.manualPayId },
      {
        amountCents: 50000,
      },
    );
    expect(res.statusCode).toBe(200);
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, s.invoiceId));
    expect(Number(inv!.paidCents)).toBe(90000); // 50000 manual + 40000 stripe
    expect(inv!.status).toBe('PARTIALLY_PAID');
  });

  it('voids a manual payment, excluding it from paid', async () => {
    const s = await seed();
    const res = await call(
      router(),
      'post',
      '/:id/void',
      s.firmId,
      s.appUserId,
      { id: s.manualPayId },
      {
        reason: 'entered twice',
      },
    );
    expect(res.statusCode).toBe(200);
    const [pay] = await harness.db.select().from(payments).where(eq(payments.id, s.manualPayId));
    expect(pay!.voidedAt).not.toBeNull();
    const [inv] = await harness.db.select().from(invoices).where(eq(invoices.id, s.invoiceId));
    expect(Number(inv!.paidCents)).toBe(40000); // only the Stripe payment remains
  });

  it('refuses to edit or void a Stripe-processed payment', async () => {
    const s = await seed();
    const edit = await call(
      router(),
      'patch',
      '/:id',
      s.firmId,
      s.appUserId,
      { id: s.stripePayId },
      {
        amountCents: 1,
      },
    );
    expect(edit.statusCode).toBe(409);
    const voidRes = await call(
      router(),
      'post',
      '/:id/void',
      s.firmId,
      s.appUserId,
      { id: s.stripePayId },
      {},
    );
    expect(voidRes.statusCode).toBe(409);
  });
});
