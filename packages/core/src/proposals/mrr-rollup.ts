// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P29 — MRR + cash flow rollup math.
//
// Pure helpers. The API hands in:
//   • active recurring billing plans (engagement_id, amount_cents,
//     frequency, status, optional started_at) — drives current MRR
//   • plans that started this month — drives "new MRR"
//   • plans that closed last month — drives "churned MRR"
//   • a prior-month MRR figure — drives MoM delta
//   • invoices (issue_date, due_date, total_cents, paid_cents, status) —
//     drives cash flow
//   • mandate state counts
//   • renewal candidate rows (already in renewals table from P25)
//
// All math returns POJOs. No DB.

export type RecurringFrequency =
  | 'WEEKLY'
  | 'BIWEEKLY'
  | 'MONTHLY'
  | 'QUARTERLY'
  | 'SEMIANNUAL'
  | 'ANNUAL';

// Number of billings per year for each frequency, used to normalize to
// monthly recurring revenue.
const PER_YEAR: Record<RecurringFrequency, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  MONTHLY: 12,
  QUARTERLY: 4,
  SEMIANNUAL: 2,
  ANNUAL: 1,
};

export interface PlanForMrr {
  engagementId: string;
  amountCents: number;
  frequency: RecurringFrequency;
  // Optional category tag. The API populates it from the engagement's
  // service_line / engagement_type — for the helper it's just a string.
  category?: string | null;
}

export interface InvoiceForCashFlow {
  id: string;
  totalCents: number;
  paidCents: number;
  dueDate: string; // ISO date
  status: 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOIDED';
}

export interface MandateCounts {
  pendingVerification: number;
  active: number;
  invalid: number;
  revoked: number;
}

export interface RenewalRowForDashboard {
  id: string;
  engagementId: string;
  endDate: string; // ISO date
  currentTotalCents: number;
  suggestedTotalCents: number | null;
  upliftBps: number | null;
  state: 'CANDIDATE' | 'PROPOSED' | 'ACCEPTED' | 'DECLINED' | 'DISMISSED';
}

export interface MrrInput {
  // ISO date for "today". Drives bucketing.
  now: string;
  activePlans: PlanForMrr[];
  // Plans that started in the current month — i.e. plan.created_at in
  // [startOfMonth(now), now]. Caller filters.
  newPlansThisMonth: PlanForMrr[];
  // Plans whose engagement was closed in the last month.
  churnedPlansLastMonth: PlanForMrr[];
  // Same shape as currentMrrCents from the prior month (we'd compute it
  // via a snapshot table in prod; for v1 the caller passes it).
  priorMonthMrrCents: number | null;
  invoices: InvoiceForCashFlow[];
  mandates: MandateCounts;
  renewals: RenewalRowForDashboard[];
  // For the annual revenue forecast: sum of `total_one_time_cents`
  // across proposals expected to close. Caller decides what "expected"
  // means (DRAFT/SENT/VIEWED with high probability, etc.).
  onCompletionPipelineCents: number;
}

export interface MrrPerCategory {
  category: string;
  mrrCents: number;
  planCount: number;
}

export interface CashFlowBucket {
  windowDays: 30 | 60 | 90;
  expectedCents: number;
  invoiceCount: number;
}

export interface FailedInvoice {
  id: string;
  totalCents: number;
  dueDate: string;
  daysOverdue: number;
}

export interface RenewalsByWindow {
  endsWithin30Days: RenewalRowForDashboard[];
  endsWithin60Days: RenewalRowForDashboard[];
  endsWithin90Days: RenewalRowForDashboard[];
}

export interface MrrResult {
  currentMrrCents: number;
  monthOverMonthDeltaCents: number | null;
  newMrrCents: number;
  churnedMrrCents: number;
  netNewMrrCents: number;
  byCategory: MrrPerCategory[];
  cashFlow: CashFlowBucket[];
  failedInvoices: FailedInvoice[];
  mandateHealth: MandateCounts;
  renewals: RenewalsByWindow;
  annualForecastCents: number;
}

export function planToMonthlyCents(plan: PlanForMrr): number {
  const perYear = PER_YEAR[plan.frequency];
  return Math.round((plan.amountCents * perYear) / 12);
}

function sumMrr(plans: PlanForMrr[]): number {
  let total = 0;
  for (const p of plans) total += planToMonthlyCents(p);
  return total;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setUTCHours(0, 0, 0, 0);
  return c;
}

export function computeMrrRollup(input: MrrInput): MrrResult {
  const nowDate = new Date(input.now);

  // ---- MRR -------------------------------------------------------
  const currentMrrCents = sumMrr(input.activePlans);
  const newMrrCents = sumMrr(input.newPlansThisMonth);
  const churnedMrrCents = sumMrr(input.churnedPlansLastMonth);

  const monthOverMonthDeltaCents =
    input.priorMonthMrrCents == null ? null : currentMrrCents - input.priorMonthMrrCents;

  // By category
  const catMap = new Map<string, MrrPerCategory>();
  for (const p of input.activePlans) {
    const key = p.category ?? '(uncategorized)';
    const monthly = planToMonthlyCents(p);
    const existing = catMap.get(key);
    if (existing) {
      existing.mrrCents += monthly;
      existing.planCount += 1;
    } else {
      catMap.set(key, { category: key, mrrCents: monthly, planCount: 1 });
    }
  }

  // ---- Cash flow -------------------------------------------------
  const today = startOfDay(nowDate);
  const todayMs = today.getTime();
  const cashFlow: CashFlowBucket[] = ([30, 60, 90] as const).map((days) => {
    const cutoffMs = todayMs + days * 86_400_000;
    let expected = 0;
    let count = 0;
    for (const inv of input.invoices) {
      if (inv.status === 'PAID' || inv.status === 'VOIDED' || inv.status === 'DRAFT') continue;
      const dueMs = Date.parse(inv.dueDate);
      if (!Number.isFinite(dueMs)) continue;
      if (dueMs < todayMs) continue; // overdue handled in failedInvoices
      if (dueMs > cutoffMs) continue;
      expected += Math.max(0, inv.totalCents - inv.paidCents);
      count += 1;
    }
    return { windowDays: days, expectedCents: expected, invoiceCount: count };
  });

  // ---- Failed (overdue) invoices --------------------------------
  const failed: FailedInvoice[] = [];
  for (const inv of input.invoices) {
    if (inv.status === 'PAID' || inv.status === 'VOIDED' || inv.status === 'DRAFT') continue;
    const dueMs = Date.parse(inv.dueDate);
    if (!Number.isFinite(dueMs) || dueMs >= todayMs) continue;
    const daysOverdue = Math.floor((todayMs - dueMs) / 86_400_000);
    failed.push({
      id: inv.id,
      totalCents: inv.totalCents - inv.paidCents,
      dueDate: inv.dueDate,
      daysOverdue,
    });
  }
  failed.sort((a, b) => b.daysOverdue - a.daysOverdue);

  // ---- Renewals --------------------------------------------------
  const renewalBuckets: RenewalsByWindow = {
    endsWithin30Days: [],
    endsWithin60Days: [],
    endsWithin90Days: [],
  };
  for (const r of input.renewals) {
    const endMs = Date.parse(r.endDate);
    if (!Number.isFinite(endMs)) continue;
    const days = Math.floor((endMs - todayMs) / 86_400_000);
    if (days < 0 || days > 90) continue;
    if (days <= 30) renewalBuckets.endsWithin30Days.push(r);
    else if (days <= 60) renewalBuckets.endsWithin60Days.push(r);
    else renewalBuckets.endsWithin90Days.push(r);
  }

  // ---- Forecast --------------------------------------------------
  const annualForecastCents = currentMrrCents * 12 + input.onCompletionPipelineCents;

  return {
    currentMrrCents,
    monthOverMonthDeltaCents,
    newMrrCents,
    churnedMrrCents,
    netNewMrrCents: newMrrCents - churnedMrrCents,
    byCategory: Array.from(catMap.values()).sort((a, b) => b.mrrCents - a.mrrCents),
    cashFlow,
    failedInvoices: failed,
    mandateHealth: input.mandates,
    renewals: renewalBuckets,
    annualForecastCents,
  };
}
