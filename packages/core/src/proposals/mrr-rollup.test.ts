// SPDX-License-Identifier: Elastic-2.0
//
// P29 — MRR / cash flow rollup tests.

import { describe, expect, it } from 'vitest';
import {
  computeMrrRollup,
  planToMonthlyCents,
  type InvoiceForCashFlow,
  type MrrInput,
  type PlanForMrr,
  type RenewalRowForDashboard,
} from './mrr-rollup';

const NOW = '2026-05-26T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

function daysFromNow(d: number): string {
  return new Date(NOW_MS + d * 86_400_000).toISOString().slice(0, 10);
}

function plan(o: Partial<PlanForMrr> & { engagementId: string }): PlanForMrr {
  return {
    engagementId: o.engagementId,
    amountCents: o.amountCents ?? 100_000,
    frequency: o.frequency ?? 'MONTHLY',
    category: o.category ?? null,
  };
}

function emptyMandates() {
  return { pendingVerification: 0, active: 0, invalid: 0, revoked: 0 };
}
function emptyInput(over: Partial<MrrInput> = {}): MrrInput {
  return {
    now: NOW,
    activePlans: [],
    newPlansThisMonth: [],
    churnedPlansLastMonth: [],
    priorMonthMrrCents: null,
    invoices: [],
    mandates: emptyMandates(),
    renewals: [],
    onCompletionPipelineCents: 0,
    ...over,
  };
}

describe('P29 — planToMonthlyCents', () => {
  it('MONTHLY: pass-through', () => {
    expect(planToMonthlyCents(plan({ engagementId: 'e1', amountCents: 100_000 }))).toBe(100_000);
  });
  it('QUARTERLY → /3', () => {
    expect(
      planToMonthlyCents(plan({ engagementId: 'e1', amountCents: 30_000, frequency: 'QUARTERLY' })),
    ).toBe(10_000);
  });
  it('ANNUAL → /12', () => {
    expect(
      planToMonthlyCents(plan({ engagementId: 'e1', amountCents: 120_000, frequency: 'ANNUAL' })),
    ).toBe(10_000);
  });
  it('WEEKLY: 52/12 ≈ 4.333', () => {
    // 1000 * 52 / 12 = 4_333.33 → round to 4_333
    expect(
      planToMonthlyCents(plan({ engagementId: 'e1', amountCents: 1_000, frequency: 'WEEKLY' })),
    ).toBe(4_333);
  });
});

describe('P29 — MRR aggregation', () => {
  it('sums plans + MoM delta', () => {
    const r = computeMrrRollup(
      emptyInput({
        activePlans: [
          plan({ engagementId: 'e1', amountCents: 100_000 }),
          plan({ engagementId: 'e2', amountCents: 50_000, frequency: 'QUARTERLY' }),
        ],
        priorMonthMrrCents: 90_000,
      }),
    );
    // 100k + (50k/3 rounded) = 100k + 16_667 = 116_667
    expect(r.currentMrrCents).toBe(116_667);
    expect(r.monthOverMonthDeltaCents).toBe(116_667 - 90_000);
  });

  it('new + churned + netNew', () => {
    const r = computeMrrRollup(
      emptyInput({
        activePlans: [plan({ engagementId: 'e1', amountCents: 80_000 })],
        newPlansThisMonth: [plan({ engagementId: 'e2', amountCents: 30_000 })],
        churnedPlansLastMonth: [plan({ engagementId: 'e3', amountCents: 10_000 })],
      }),
    );
    expect(r.newMrrCents).toBe(30_000);
    expect(r.churnedMrrCents).toBe(10_000);
    expect(r.netNewMrrCents).toBe(20_000);
  });

  it('null prior month → null delta', () => {
    const r = computeMrrRollup(
      emptyInput({
        activePlans: [plan({ engagementId: 'e1' })],
        priorMonthMrrCents: null,
      }),
    );
    expect(r.monthOverMonthDeltaCents).toBeNull();
  });

  it('byCategory: sorted desc by MRR', () => {
    const r = computeMrrRollup(
      emptyInput({
        activePlans: [
          plan({ engagementId: 'e1', amountCents: 100_000, category: 'bookkeeping' }),
          plan({ engagementId: 'e2', amountCents: 200_000, category: 'tax' }),
          plan({ engagementId: 'e3', amountCents: 50_000, category: 'bookkeeping' }),
        ],
      }),
    );
    expect(r.byCategory[0]!.category).toBe('tax');
    expect(r.byCategory[0]!.mrrCents).toBe(200_000);
    expect(r.byCategory[1]!.category).toBe('bookkeeping');
    expect(r.byCategory[1]!.mrrCents).toBe(150_000);
    expect(r.byCategory[1]!.planCount).toBe(2);
  });
});

describe('P29 — cash flow buckets', () => {
  function inv(p: Partial<InvoiceForCashFlow> & { id: string }): InvoiceForCashFlow {
    return {
      id: p.id,
      totalCents: p.totalCents ?? 100_000,
      paidCents: p.paidCents ?? 0,
      dueDate: p.dueDate ?? daysFromNow(15),
      status: p.status ?? 'SENT',
    };
  }
  it('bucket each invoice by due-date window', () => {
    const r = computeMrrRollup(
      emptyInput({
        invoices: [
          inv({ id: 'a', dueDate: daysFromNow(15), totalCents: 10_000 }),
          inv({ id: 'b', dueDate: daysFromNow(45), totalCents: 20_000 }),
          inv({ id: 'c', dueDate: daysFromNow(75), totalCents: 30_000 }),
          inv({ id: 'd', dueDate: daysFromNow(100), totalCents: 99_999 }), // outside 90d
        ],
      }),
    );
    const b30 = r.cashFlow.find((b) => b.windowDays === 30)!;
    expect(b30.expectedCents).toBe(10_000);
    expect(b30.invoiceCount).toBe(1);
    const b60 = r.cashFlow.find((b) => b.windowDays === 60)!;
    expect(b60.invoiceCount).toBe(2);
    const b90 = r.cashFlow.find((b) => b.windowDays === 90)!;
    expect(b90.expectedCents).toBe(10_000 + 20_000 + 30_000);
  });

  it('excludes paid, voided, draft', () => {
    const r = computeMrrRollup(
      emptyInput({
        invoices: [
          inv({ id: 'p', status: 'PAID' }),
          inv({ id: 'v', status: 'VOIDED' }),
          inv({ id: 'd', status: 'DRAFT' }),
          inv({ id: 'open', status: 'SENT' }),
        ],
      }),
    );
    const b30 = r.cashFlow.find((b) => b.windowDays === 30)!;
    expect(b30.invoiceCount).toBe(1);
  });

  it('subtracts paid_cents from expected', () => {
    const r = computeMrrRollup(
      emptyInput({
        invoices: [
          inv({ id: 'partial', totalCents: 100_000, paidCents: 40_000, status: 'PARTIALLY_PAID' }),
        ],
      }),
    );
    expect(r.cashFlow[0]!.expectedCents).toBe(60_000);
  });
});

describe('P29 — failed (overdue) invoices', () => {
  it('lists overdue invoices sorted by daysOverdue desc', () => {
    const r = computeMrrRollup(
      emptyInput({
        invoices: [
          {
            id: 'old',
            totalCents: 100_000,
            paidCents: 0,
            dueDate: daysFromNow(-30),
            status: 'OVERDUE',
          },
          {
            id: 'recent',
            totalCents: 50_000,
            paidCents: 0,
            dueDate: daysFromNow(-5),
            status: 'OVERDUE',
          },
          {
            id: 'paid',
            totalCents: 999_999,
            paidCents: 999_999,
            dueDate: daysFromNow(-100),
            status: 'PAID',
          },
        ],
      }),
    );
    expect(r.failedInvoices.length).toBe(2);
    expect(r.failedInvoices[0]!.id).toBe('old');
    expect(r.failedInvoices[0]!.daysOverdue).toBe(30);
  });
});

describe('P29 — renewals by window', () => {
  function ren(
    p: Partial<RenewalRowForDashboard> & { id: string; endDate: string },
  ): RenewalRowForDashboard {
    return {
      id: p.id,
      engagementId: p.engagementId ?? 'e',
      endDate: p.endDate,
      currentTotalCents: p.currentTotalCents ?? 100_000,
      suggestedTotalCents: p.suggestedTotalCents ?? null,
      upliftBps: p.upliftBps ?? null,
      state: p.state ?? 'CANDIDATE',
    };
  }
  it('buckets by 30/60/90', () => {
    const r = computeMrrRollup(
      emptyInput({
        renewals: [
          ren({ id: 'r1', endDate: daysFromNow(15) }),
          ren({ id: 'r2', endDate: daysFromNow(45) }),
          ren({ id: 'r3', endDate: daysFromNow(75) }),
          ren({ id: 'r4', endDate: daysFromNow(120) }), // out of window
        ],
      }),
    );
    expect(r.renewals.endsWithin30Days.length).toBe(1);
    expect(r.renewals.endsWithin60Days.length).toBe(1);
    expect(r.renewals.endsWithin90Days.length).toBe(1);
  });
});

describe('P29 — forecast', () => {
  it('annualForecastCents = currentMrr × 12 + onCompletionPipeline', () => {
    const r = computeMrrRollup(
      emptyInput({
        activePlans: [plan({ engagementId: 'e1', amountCents: 100_000 })],
        onCompletionPipelineCents: 500_000,
      }),
    );
    // 100k MRR × 12 + 500k = 1.7M
    expect(r.annualForecastCents).toBe(1_700_000);
  });
});

describe('P29 — mandate health passes through', () => {
  it('echoes the input counts', () => {
    const r = computeMrrRollup(
      emptyInput({
        mandates: { pendingVerification: 1, active: 10, invalid: 2, revoked: 0 },
      }),
    );
    expect(r.mandateHealth.invalid).toBe(2);
    expect(r.mandateHealth.active).toBe(10);
  });
});
