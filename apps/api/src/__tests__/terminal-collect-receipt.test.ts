// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// In-person terminal "collect a multi-invoice payment" (/payments/new
// Terminal mode): creates a PENDING grouped receipt with the allocations,
// stamps the card_present PaymentIntent id, and pushes it to the reader.
// The Stripe Terminal HTTP layer is mocked (no live account / reader).

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';
import { paymentReceipts } from '@vibe/db/schema';
import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';

const processSpy = vi.fn(async () => ({ readerId: 'tmr_1', actionStatus: 'in_progress' }));
vi.mock('../stripe-connect/terminal', () => ({
  createCardPresentIntent: vi.fn(async () => ({
    id: 'pi_test_123',
    status: 'requires_payment_method',
  })),
  processPaymentIntent: processSpy,
  createTerminalLocation: vi.fn(),
  registerTerminalReader: vi.fn(),
  capturePaymentIntent: vi.fn(),
  cancelPaymentIntent: vi.fn(),
  cancelReaderAction: vi.fn(),
}));

// Imported AFTER the mock is registered.
const { createTerminalRouter } = await import('../terminal/routes');

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

function app(secretKey: string | null = 'sk_test_dummy'): express.Express {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { staffSession: unknown }).staffSession = {
      firmId: seed.firmId,
      appUserId: seed.appUserId,
    };
    next();
  });
  a.use(
    '/api/staff/terminal',
    createTerminalRouter({
      db: harness.db,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]),
      secretKey,
    }),
  );
  return a;
}

async function setup(
  stripeMode: 'oauth' | 'direct' | 'none' = 'oauth',
): Promise<{ readerId: string; invoiceId: string }> {
  const { firmId, clientId, engagementId } = seed;
  if (stripeMode === 'oauth') {
    // Stripe Connect OAuth — connected account id + platform key.
    await harness.db.execute(
      sql`INSERT INTO firm_settings_proposals (firm_id, stripe_account_id, stripe_account_capabilities)
          VALUES (${firmId}, 'acct_test', '{}'::jsonb)`,
    );
  } else if (stripeMode === 'direct') {
    // Direct pasted firm keys (the primary Q7 mode) — encrypted at rest,
    // resolved per request via resolveFirmStripe. No connected account row.
    process.env['KMS_KEY'] = Buffer.alloc(32, 7).toString('base64');
    const { encryptStripeConfig } = await import('../payments/stripe-resolver');
    const enc = encryptStripeConfig({ secretKey: 'sk_test_direct' });
    await harness.db.execute(
      sql`INSERT INTO firm_settings (firm_id, stripe_config_encrypted) VALUES (${firmId}, ${enc})`,
    );
  }
  const loc = await harness.db.execute(
    sql`INSERT INTO terminal_locations (firm_id, stripe_location_id, display_name)
        VALUES (${firmId}, 'tml_1', 'Front desk') RETURNING id`,
  );
  const locationId = (loc as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const rdr = await harness.db.execute(
    sql`INSERT INTO terminal_readers (firm_id, location_id, stripe_reader_id, label, status)
        VALUES (${firmId}, ${locationId}, 'tmr_1', 'WisePOS', 'online') RETURNING id`,
  );
  const readerId = (rdr as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const inv = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                             issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'INV-1', '2026-06-01', '2026-06-15',
                100000, 100000, 'SENT') RETURNING id`,
  );
  const invoiceId = (inv as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return { readerId, invoiceId };
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  processSpy.mockClear();
});
afterEach(async () => {
  delete process.env['KMS_KEY'];
  await harness.close();
});

describe('terminal collect-receipt', () => {
  it('creates a PENDING receipt with allocations + PI, and pushes to the reader', async () => {
    const { readerId, invoiceId } = await setup();
    const res = await request(app())
      .post('/api/staff/terminal/collect-receipt')
      .send({
        readerId,
        payerClientId: seed.clientId,
        paymentDate: '2026-06-10',
        allocations: [{ invoiceId, amountCents: 60000 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.paymentIntentId).toBe('pi_test_123');
    expect(processSpy).toHaveBeenCalledTimes(1);

    const [receipt] = await harness.db
      .select()
      .from(paymentReceipts)
      .where(eq(paymentReceipts.id, res.body.receiptId));
    expect(receipt!.status).toBe('PENDING');
    expect(Number(receipt!.totalCents)).toBe(60000);
    expect(receipt!.providerChargeId).toBe('pi_test_123');
    expect(receipt!.paymentMethod).toBe('CARD_PRESENT');
    expect(receipt!.allocationsPending).toEqual([{ invoiceId, amountCents: 60000 }]);
  });

  it('works with direct (pasted) firm keys — no Connect OAuth account', async () => {
    const { readerId, invoiceId } = await setup('direct');
    // secretKey null: nothing injected at boot, so conn() must resolve the
    // pasted key from the DB (the production configuration).
    const res = await request(app(null))
      .post('/api/staff/terminal/collect-receipt')
      .send({
        readerId,
        payerClientId: seed.clientId,
        paymentDate: '2026-06-10',
        allocations: [{ invoiceId, amountCents: 25000 }],
      });
    expect(res.status).toBe(200);
    expect(res.body.paymentIntentId).toBe('pi_test_123');
    expect(processSpy).toHaveBeenCalledTimes(1);
  });

  it('409s when no Stripe credentials exist in any mode', async () => {
    const { readerId, invoiceId } = await setup('none');
    const res = await request(app(null))
      .post('/api/staff/terminal/collect-receipt')
      .send({
        readerId,
        payerClientId: seed.clientId,
        paymentDate: '2026-06-10',
        allocations: [{ invoiceId, amountCents: 25000 }],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('stripe_not_connected');
  });

  it('404s for an invoice that is not in the firm', async () => {
    const { readerId } = await setup();
    const res = await request(app())
      .post('/api/staff/terminal/collect-receipt')
      .send({
        readerId,
        payerClientId: seed.clientId,
        paymentDate: '2026-06-10',
        allocations: [{ invoiceId: '00000000-0000-0000-0000-000000000000', amountCents: 100 }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invoice_not_found');
  });
});
