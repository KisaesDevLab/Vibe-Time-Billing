---
title: 'Payroll timekeeping'
slug: payroll-timekeeping
category: admin
audience: admin
tags: ['payroll', 'overtime', 'PTO', 'sick', 'accrual', 'pay period', 'exempt']
---

# Payroll timekeeping

Vibe turns logged time into payroll input: overtime for non-exempt staff, PTO/Sick/Comp accrual and usage, and a per-pay-period report you hand to payroll. Configure it under **Admin → Payroll**; run each period from **Payroll review** (`/payroll/review`).

## One-time setup (Admin → Payroll)

1. **Enable payroll timekeeping** and set:
   - **Workweek starts** — the day the FLSA workweek begins (overtime is hours over 40 per workweek).
   - **Pay period** — weekly, biweekly, semi-monthly (1–15 / 16–EOM), or monthly. Weekly/biweekly also need an **anchor date** (any known period start).
   - **Comp multiplier** — the rate used when converting OT hours to comp time (default 1.5×).
2. **Accrual policies** — create one per bank (PTO / Sick / Comp). Methods: fixed hours per pay period, earned per hours worked (e.g. 1 per 30), or an annual grant (Jan 1 or hire anniversary). Each policy can set accrual/usage waiting periods for new hires, a max balance ceiling, tenure tiers (rate steps up with years of service), and a year-end carryover cap (excess forfeits on Jan 1).
3. **Assignments** — assign a policy per employee per bank in the matrix. Only **full-time** employees accrue.
4. **Work-code categories** — the seeded codes (`pto`, `sick_leave`, `holiday`, `comp_time_used`, `unpaid_leave`) are pre-tagged; tag any additional codes so their hours land in the right payroll bucket.
5. **Per-employee flags** — on each user's **Payroll** tab (Admin → Users → user): **Exempt from overtime** (salaried; the report shows standard hours, no OT) and **Full-time** (gates accrual). The same tab shows balances, ledger history, and the **manual adjustment** form — use it for go-live starting balances, corrections, or comp grants (signed hours + required note, all append-only and audit-logged).

Holidays are logged by staff with the **Holiday** work code; the Admin → Holidays calendar stays a reference.

## Accrual runs automatically

A nightly job materializes pay periods and writes accruals for each completed period (plus annual grants); a Jan-1 job applies carryover caps. Both are idempotent and visible under **Admin → Jobs** (`payroll-accrual`, `payroll-carryover`) where you can run them on demand.

## Running a payroll period

On **Payroll review**, pick the period. Each employee row shows **Regular, OT, PTO, Sick, Comp used, Holiday, Unpaid**, and actual logged hours (exempt staff: standard hours drive pay; actuals are informational). Missing-day flags mark weekdays with no hours.

1. Chase down flags and fix entries as needed.
2. Optionally **convert OT to comp** (removes hours from reported OT, credits the comp bank at the multiplier).
3. **Approve** each employee, then **Lock period** — entries dated inside a locked period can no longer be added, edited, or deleted (separate from billing locks). Unlock is available (audit-logged) if a correction is needed.
4. **Export CSV** for payroll entry (one row per employee), or print a PDF from the report viewer.

## Reports

- **Payroll period** — the per-employee hour buckets for any period (Reports → Payroll period).
- **Time-off balances** — accrued vs used vs balance per employee per bank, for year-end review and PTO-liability accruals.
- **Employee daily detail** — click any employee on Payroll review for the day-by-day breakdown.
