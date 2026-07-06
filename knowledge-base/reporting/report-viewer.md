---
title: 'The detailed report viewer'
slug: report-viewer
category: reporting
audience: staff
tags: ['reports', 'viewer', 'csv', 'pdf', 'analytics']
---

# The report viewer

Many report-library tiles open the **report viewer** at `/reports/view/<report>` — a table view for one report with its own parameters and exports.

## Who can do this

Staff with reporting access. The viewer reads aggregate firm data; it has no write actions.

## Steps

1. From **Reports**, pick a report-library tile, or navigate to `/reports/view/<kind>`.
2. Fill any parameter inputs the report exposes — typically **Start (YYYY-MM-DD)** and **End (YYYY-MM-DD)**, or a report-specific field (see below).
3. Click **Run** to execute and populate the table.
4. Read the results — rows resolve **names, not raw IDs** (a partner, client, or engagement name instead of a long identifier).
5. Export with **⬇ CSV** or **⬇ PDF** (the PDF mirrors the on-screen, formatted table).

## Field reference — available reports

The viewer ships these report kinds:

- **Realization by partner** — write-up/down realization grouped by partner in charge.
- **Revenue by month** — billed + paid per calendar month (last 24). Has a **Basis** toggle: **Accrual** buckets by invoice issue month; **Cash** shows net cash collected by payment-receipt month.
- **Utilization** — billable vs total and vs available capacity (default 30 days).
- **Effective rate** — billed value ÷ billable hours per timekeeper (default 90 days; **Start**, **End**).
- **Time by engagement** — hours + standard value per engagement.
- **Time by client** — hours + standard value per client.
- **Collection realization** — paid ÷ billed per partner (default 90 days). On **Cash** basis, "paid" is money received in the window (receipt-dated); on **Accrual** it is lifetime paid on invoices issued in the window.
- **Book of business** — active clients + billed/paid per partner (default 365 days). **Basis** toggle: cash dates "paid" by payment receipt.
- **Client lifetime value** — lifetime paid + billed revenue per client (top 200).
- **Firm profitability** — cost, billed, paid, and margin per engagement. **Basis** toggle: margin = billed − cost on accrual, collected − cost on cash.
- **Capacity forecast** — projected next-4-week billable hours vs target (**Weekly target hrs**, **Start**, **End**).
- **Productivity by office** — hours + utilization per office (**Window (days)**).
- **Billable targets** — month-to-date billable hours vs the prorated monthly target (**Target override**).
- **Scope creep** — out-of-scope hours per mixed-mode engagement.
- **Approval metrics** — approval counts, rates, and response time per approver (**Window (days)**, default 90).
- **Time anomalies** — per-timekeeper daily-hours outliers by z-score (**Start**, **End**).
- **Subscription profitability** — retainer revenue vs cost-to-serve over a trailing window (**Window (days)** or **Start**).
- **Client-request capture** — billable time captured against fulfilled client requests (**Start**, **End**).
- **Revenue period-over-period** — month-over-month revenue change with the same **Basis** toggle (billed on accrual, net cash collected on cash).

## Common errors

Dates are entered as plain **YYYY-MM-DD** text; reports with their own default window (e.g. last 90 days) still run if you leave parameters blank. If a table is empty after **Run**, the window or override likely excluded all rows.

Related: [[reporting-overview]], [[saved-reports]], [[anomaly-scope-creep]], [[dashboard-overview]]
