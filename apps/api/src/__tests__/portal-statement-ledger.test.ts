// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Portal statement A/R ledger: default year-to-date window, always-full
// lifetime totals, running balance over the whole history, invoice /
// payment / refund rows, and date validation.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { clientPortalAccess, invoices, payments, portalIdentity } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createPortalProfileRouter, type PortalProfileDeps } from '../portal/profile';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let identityId: string;

const THIS_YEAR = new Date().toISOString().slice(0, 4);

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { portalSession: unknown }).portalSession = {
      realm: 'portal',
      firmId: seed.firmId,
      portalIdentityId: identityId,
      activeClientId: seed.clientId,
    };
    next();
  });
  const deps = {
    db: harness.db,
    requireAuth: (_req, _res, next) => next(),
  } as PortalProfileDeps;
  app.use('/api/portal/profile', createPortalProfileRouter(deps));
  return app;
}

async function seedInvoice(args: {
  number: string;
  issueDate: string;
  totalCents: number;
  paidCents?: number;
  status: string;
}): Promise<string> {
  const [row] = await harness.db
    .insert(invoices)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      invoiceNumber: args.number,
      issueDate: args.issueDate,
      dueDate: args.issueDate,
      subtotalCents: args.totalCents,
      totalCents: args.totalCents,
      paidCents: args.paidCents ?? 0,
      status: args.status as never,
    })
    .returning({ id: invoices.id });
  return row!.id;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  const [ident] = await harness.db
    .insert(portalIdentity)
    .values({
      firmId: seed.firmId,
      fullName: 'Pat Portal',
      primaryEmail: 'pat@example.test',
    })
    .returning({ id: portalIdentity.id });
  identityId = ident!.id;
  await harness.db.insert(clientPortalAccess).values({
    portalIdentityId: identityId,
    clientId: seed.clientId,
    status: 'ACTIVE',
  });
});
afterEach(async () => {
  await harness.close();
});

describe('portal statement ledger', () => {
  it('defaults to year-to-date rows but lifetime totals', async () => {
    await seedInvoice({
      number: 'OLD-1',
      issueDate: '2020-03-01',
      totalCents: 10000,
      paidCents: 10000,
      status: 'PAID',
    });
    await seedInvoice({
      number: 'NEW-1',
      issueDate: `${THIS_YEAR}-02-01`,
      totalCents: 25000,
      status: 'SENT',
    });

    const res = await request(buildApp()).get('/api/portal/profile/statement');
    expect(res.status).toBe(200);
    // Ledger window: only the current-year invoice.
    expect(res.body.ledger).toHaveLength(1);
    expect(res.body.ledger[0].reference).toBe('NEW-1');
    // Running balance includes the pre-window history (10000 billed,
    // but 0 payments rows seeded — balance reflects invoice charges).
    expect(res.body.ledger[0].balanceCents).toBe(35000);
    // Totals are lifetime regardless of window.
    expect(res.body.totals).toEqual({
      billedCents: 35000,
      paidCents: 10000,
      outstandingCents: 25000,
    });
    expect(res.body.range.from).toBe(`${THIS_YEAR}-01-01`);
  });

  it('interleaves payments and refunds with running balance', async () => {
    const invId = await seedInvoice({
      number: 'INV-9',
      issueDate: `${THIS_YEAR}-01-10`,
      totalCents: 50000,
      paidCents: 30000,
      status: 'PARTIALLY_PAID',
    });
    const [pay] = await harness.db
      .insert(payments)
      .values({
        invoiceId: invId,
        amountCents: 30000,
        provider: 'MANUAL',
        status: 'SUCCEEDED',
        receivedAt: new Date(`${THIS_YEAR}-01-20T12:00:00Z`),
        refundedAt: new Date(`${THIS_YEAR}-01-25T12:00:00Z`),
        refundedAmountCents: 5000,
      })
      .returning({ id: payments.id });

    const res = await request(buildApp()).get(
      `/api/portal/profile/statement?from=${THIS_YEAR}-01-01&to=${THIS_YEAR}-12-31`,
    );
    expect(res.status).toBe(200);
    const types = res.body.ledger.map((r: { type: string }) => r.type);
    expect(types).toEqual(['INVOICE', 'PAYMENT', 'REFUND']);
    const balances = res.body.ledger.map((r: { balanceCents: number }) => r.balanceCents);
    expect(balances).toEqual([50000, 20000, 25000]);
    expect(res.body.ledger[1].paymentId).toBe(pay!.id);
    expect(res.body.ledger[1].invoiceId).toBe(invId);
  });

  it('excludes voided payments and draft invoices', async () => {
    const invId = await seedInvoice({
      number: 'INV-V',
      issueDate: `${THIS_YEAR}-03-01`,
      totalCents: 10000,
      status: 'SENT',
    });
    await seedInvoice({
      number: 'DRAFT-1',
      issueDate: `${THIS_YEAR}-03-02`,
      totalCents: 99999,
      status: 'DRAFT',
    });
    await harness.db.insert(payments).values({
      invoiceId: invId,
      amountCents: 10000,
      provider: 'MANUAL',
      status: 'SUCCEEDED',
      receivedAt: new Date(`${THIS_YEAR}-03-05T12:00:00Z`),
      voidedAt: new Date(`${THIS_YEAR}-03-06T12:00:00Z`),
    });

    const res = await request(buildApp()).get('/api/portal/profile/statement');
    const refs = res.body.ledger.map((r: { reference: string }) => r.reference);
    expect(refs).toEqual(['INV-V']);
  });

  it('rejects malformed dates', async () => {
    const res = await request(buildApp()).get(
      '/api/portal/profile/statement?from=03/01/2026&to=bad',
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_date');
  });
});
