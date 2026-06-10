// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Grouped payment-receipt document (one received payment across one-or-many
// invoices): the HTML renderer + the staff print/email endpoints.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { sql } from 'drizzle-orm';

import type { RoleSlug } from '@vibe/core/rbac';
import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { createPaymentRouter } from '../payments/routes';
import { renderPaymentReceiptHtml } from '../payments/receipt-doc';

describe('renderPaymentReceiptHtml', () => {
  it('renders firm, payer, method, allocations + total; escapes names', () => {
    const html = renderPaymentReceiptHtml({
      firmName: 'Acme & Co <CPA>',
      receiptId: 'abcdef12-0000-0000-0000-000000000000',
      paymentDate: '2026-06-10',
      methodLabel: 'Check',
      reference: 'check #1234',
      payerName: 'Allen, David',
      totalCents: 150000,
      lines: [
        { invoiceNumber: 'INV-1', amountCents: 100000 },
        { invoiceNumber: 'INV-2', amountCents: 50000 },
      ],
    });
    expect(html).toContain('Acme &amp; Co &lt;CPA&gt;');
    expect(html).toContain('Allen, David');
    expect(html).toContain('Check');
    expect(html).toContain('check #1234');
    expect(html).toContain('Invoice #INV-1');
    expect(html).toContain('Invoice #INV-2');
    expect(html).toContain('$1,500.00');
  });
});

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let mailbox: Array<{ to: string; subject: string; html?: string }>;

function app(): express.Express {
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
    '/api/staff/payments',
    createPaymentRouter({
      db: harness.db,
      stripe: null,
      fakeUserRoles: new Map<string, RoleSlug[]>([[seed.appUserId, ['admin']]]),
      sendStaffMail: async (m) => {
        mailbox.push({ to: m.to, subject: m.subject, html: m.html });
      },
    }),
  );
  return a;
}

async function seedReceipt(): Promise<string> {
  const { firmId, clientId, engagementId } = seed;
  const inv = await harness.db.execute(
    sql`INSERT INTO invoice (firm_id, client_id, primary_engagement_id, invoice_number,
                             issue_date, due_date, subtotal_cents, total_cents, status)
        VALUES (${firmId}, ${clientId}, ${engagementId}, 'INV-1', '2026-06-01', '2026-06-15',
                60000, 60000, 'PAID') RETURNING id`,
  );
  const invoiceId = (inv as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const rc = await harness.db.execute(
    sql`INSERT INTO payment_receipt (firm_id, payer_client_id, payment_date, reference,
                                     payment_method, mode, total_cents, provider, status)
        VALUES (${firmId}, ${clientId}, '2026-06-10', 'check #99', 'CHECK', 'RECORD',
                60000, 'MANUAL', 'SUCCEEDED') RETURNING id`,
  );
  const receiptId = (rc as unknown as { rows: { id: string }[] }).rows[0]!.id;
  await harness.db.execute(
    sql`INSERT INTO payment (invoice_id, receipt_id, amount_cents, fee_cents, provider, status, received_at)
        VALUES (${invoiceId}, ${receiptId}, 60000, 0, 'MANUAL', 'SUCCEEDED', '2026-06-10T10:00:00Z')`,
  );
  return receiptId;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  mailbox = [];
});
afterEach(async () => {
  await harness.close();
});

describe('payment receipt print/email endpoints', () => {
  it('prints the receipt as HTML', async () => {
    const receiptId = await seedReceipt();
    const res = await request(app()).get(`/api/staff/payments/receipt/${receiptId}/print.html`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Invoice #INV-1');
    expect(res.text).toContain('$600.00');
    expect(res.text).toContain('Test Client Co');
  });

  it('emails the receipt to the billing contact', async () => {
    const receiptId = await seedReceipt();
    await seedContact(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      fullName: 'Bill Ing',
      email: 'billing@client.example',
      isBilling: true,
    });
    const res = await request(app())
      .post(`/api/staff/payments/receipt/${receiptId}/email`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.to).toBe('billing@client.example');
    expect(mailbox).toHaveLength(1);
    expect(mailbox[0]!.html).toContain('Invoice #INV-1');
  });

  it('422s when the client has no billing/primary contact email', async () => {
    const receiptId = await seedReceipt();
    const res = await request(app())
      .post(`/api/staff/payments/receipt/${receiptId}/email`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('no_billing_contact_email');
    expect(mailbox).toHaveLength(0);
  });
});
