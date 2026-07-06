// SPDX-License-Identifier: Elastic-2.0
//
// Reports — ?basis=cash toggle. Cash basis dates money by payment receipt
// (net of refunds, voids excluded) instead of bucketing lifetime
// invoice.paid_cents under the invoice's issue date.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type express from 'express';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { creditApplications, creditMemos, invoices, payments, timeEntries } from '@vibe/db/schema';
import { createReportRouter } from '../reports/routes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

interface FakeReq {
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string>;
  staffSession: { firmId: string; appUserId: string };
  ip: string;
  get(_h: string): string | undefined;
}
interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
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
async function invoke(router: express.Router, path: string, req: FakeReq): Promise<FakeRes> {
  const res = makeRes();
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods['get'] === true;
  });
  if (!layer) throw new Error(`route not registered: GET ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const handler = route.stack[route.stack.length - 1]!.handle;
  await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

// Seed one invoice issued in March, paid in May (net $800 after a $200
// partial refund on a $1,000 payment). Returns the invoice id.
async function seedMarchInvoicePaidInMay(seed: {
  firmId: string;
  clientId: string;
  engagementId: string;
}): Promise<string> {
  const [inv] = await harness.db
    .insert(invoices)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      primaryEngagementId: seed.engagementId,
      invoiceNumber: 'INV-CASH-1',
      issueDate: '2026-03-10',
      dueDate: '2026-04-10',
      subtotalCents: 100000,
      totalCents: 100000,
      paidCents: 80000,
      status: 'PARTIALLY_PAID',
    })
    .returning({ id: invoices.id });
  await harness.db.insert(payments).values({
    invoiceId: inv!.id,
    provider: 'MANUAL',
    amountCents: 100000,
    refundedAmountCents: 20000,
    status: 'PARTIALLY_REFUNDED',
    receivedAt: new Date('2026-05-05T12:00:00Z'),
  });
  return inv!.id;
}

describe('Reports — ?basis=cash', () => {
  it('revenue-by-month: cash buckets by receipt month, net of refunds', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedMarchInvoicePaidInMay(seed);
    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const base = {
      body: {},
      params: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    };

    // Accrual (default): $1,000 billed lands in the issue month, March.
    const accrual = await invoke(router, '/revenue-by-month', { ...base, query: {} });
    const accrualBody = accrual.jsonBody as {
      basis: string;
      items: Array<{ month: string; totalCents: number; paidCents: number }>;
    };
    expect(accrualBody.basis).toBe('accrual');
    expect(accrualBody.items.find((i) => i.month === '2026-03')?.totalCents).toBe(100000);

    // Cash: the net $800 receipt lands in May; March has no cash row.
    const cash = await invoke(router, '/revenue-by-month', {
      ...base,
      query: { basis: 'cash' },
    });
    const cashBody = cash.jsonBody as {
      basis: string;
      items: Array<{ month: string; collectedCents: number; count: number }>;
    };
    expect(cashBody.basis).toBe('cash');
    const may = cashBody.items.find((i) => i.month === '2026-05');
    expect(may?.collectedCents).toBe(80000);
    expect(cashBody.items.find((i) => i.month === '2026-03')).toBeUndefined();
  });

  it('revenue-by-month cash: voided payments are excluded', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const invId = await seedMarchInvoicePaidInMay(seed);
    await harness.db.insert(payments).values({
      invoiceId: invId,
      provider: 'MANUAL',
      amountCents: 55500,
      status: 'SUCCEEDED',
      receivedAt: new Date('2026-05-20T12:00:00Z'),
      voidedAt: new Date('2026-05-21T12:00:00Z'),
    });
    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, '/revenue-by-month', {
      body: {},
      params: {},
      query: { basis: 'cash' },
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    const body = r.jsonBody as { items: Array<{ month: string; collectedCents: number }> };
    // Still only the $800 net receipt — the voided $555 payment is invisible.
    expect(body.items.find((i) => i.month === '2026-05')?.collectedCents).toBe(80000);
  });

  it('cash excludes MANUAL credit-memo applications but keeps cash-backed ones', async () => {
    const seed = await seedMinimalFirm(harness.db);
    const invId = await seedMarchInvoicePaidInMay(seed);
    // Courtesy write-off applied as a CREDIT payment — no money arrived.
    const [manualPay] = await harness.db
      .insert(payments)
      .values({
        invoiceId: invId,
        provider: 'CREDIT',
        amountCents: 15000,
        status: 'SUCCEEDED',
        receivedAt: new Date('2026-05-12T12:00:00Z'),
      })
      .returning({ id: payments.id });
    const [manualMemo] = await harness.db
      .insert(creditMemos)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        issuedDate: '2026-05-12',
        originalAmountCents: 15000,
        source: 'MANUAL',
      })
      .returning({ id: creditMemos.id });
    await harness.db.insert(creditApplications).values({
      creditMemoId: manualMemo!.id,
      invoiceId: invId,
      paymentId: manualPay!.id,
      amountCents: 15000,
    });
    // Overpayment-funded credit — real cash, stays in.
    const [opPay] = await harness.db
      .insert(payments)
      .values({
        invoiceId: invId,
        provider: 'CREDIT',
        amountCents: 5000,
        status: 'SUCCEEDED',
        receivedAt: new Date('2026-05-18T12:00:00Z'),
      })
      .returning({ id: payments.id });
    const [opMemo] = await harness.db
      .insert(creditMemos)
      .values({
        firmId: seed.firmId,
        clientId: seed.clientId,
        issuedDate: '2026-04-20',
        originalAmountCents: 5000,
        source: 'OVERPAYMENT',
      })
      .returning({ id: creditMemos.id });
    await harness.db.insert(creditApplications).values({
      creditMemoId: opMemo!.id,
      invoiceId: invId,
      paymentId: opPay!.id,
      amountCents: 5000,
    });

    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const r = await invoke(router, '/revenue-by-month', {
      body: {},
      params: {},
      query: { basis: 'cash' },
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    });
    const body = r.jsonBody as { items: Array<{ month: string; collectedCents: number }> };
    // $800 net real payment + $50 overpayment-backed credit; the $150
    // courtesy write-off is not cash and must not inflate collections.
    expect(body.items.find((i) => i.month === '2026-05')?.collectedCents).toBe(85000);
  });

  it('profitability: cash basis windows revenue by receipt date and drives margin', async () => {
    const seed = await seedMinimalFirm(harness.db);
    await seedMarchInvoicePaidInMay(seed);
    // 2h at $100/hr cost in May ⇒ 20000 cents cost inside the window.
    await harness.db.insert(timeEntries).values({
      engagementId: seed.engagementId,
      appUserId: seed.appUserId,
      workCodeId: seed.workCodeId,
      entryDate: '2026-05-10',
      hours: '2.00',
      standardRateSnapshotCents: 30000,
      standardAmountCents: 60000,
      costRateSnapshotCents: 10000,
    });
    const router = createReportRouter({
      db: harness.db,
      fakeUserRoles: new Map([[seed.appUserId, ['partner']]]),
    });
    const base = {
      body: {},
      params: {},
      staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
      ip: '127.0.0.1',
      get: () => undefined,
    };

    // May window, cash basis: the March invoice contributes nothing to
    // billed (issue date outside window) but its May receipt counts as paid.
    const r = await invoke(router, '/profitability', {
      ...base,
      query: { basis: 'cash', start: '2026-05-01', end: '2026-05-31' },
    });
    const body = r.jsonBody as {
      basis: string;
      items: Array<{
        engagementId: string;
        billedCents: number;
        paidCents: number;
        costCents: number;
        marginCents: number;
      }>;
    };
    expect(body.basis).toBe('cash');
    const row = body.items.find((i) => i.engagementId === seed.engagementId)!;
    expect(row.billedCents).toBe(0);
    expect(row.paidCents).toBe(80000);
    expect(row.costCents).toBe(20000);
    // Cash margin = collected − cost.
    expect(row.marginCents).toBe(60000);

    // Same window on accrual: no billed revenue → margin is just −cost, and
    // paid stays the lifetime figure of in-window invoices (none).
    const acc = await invoke(router, '/profitability', {
      ...base,
      query: { start: '2026-05-01', end: '2026-05-31' },
    });
    const accRow = (
      acc.jsonBody as { items: Array<{ engagementId: string; marginCents: number }> }
    ).items.find((i) => i.engagementId === seed.engagementId)!;
    expect(accRow.marginCents).toBe(-20000);
  });
});
