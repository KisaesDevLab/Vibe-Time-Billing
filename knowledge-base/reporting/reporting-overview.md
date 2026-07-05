---
title: 'Reporting & the analytics cube'
slug: reporting-overview
category: reporting
audience: staff
tags: ['reports', 'realization', 'utilization', 'profitability', 'mrr']
---

# Reports & analytics

The **Reports** workspace (left-nav **Reports**, at `/reports`) is the firm's analytics hub. It opens with a **Report library** card of jump-to tiles, a **Filters** card, and a stack of live report cards.

## Steps

1. Open **Reports** from the left navigation.
2. In the **Report library** card, pick a tile: **Payments received ★**, **Realization**, **Revenue ops**, **Engagement profitability**, **Subscription profitability**, **Billable targets**, **Capacity forecast**, **WIP dashboard**, **AR aging**, **AR snapshots**, or **Audit log**.
3. Set a date window in **Filters**: type a **Start** and **End** date, or click a preset — **7d**, **30d**, **90d**, **12m**. Use **Clear dates** to reset.
4. In the **Realization** card, switch the lens with the **firm**, **timekeeper**, **engagement**, **client**, or **service line** buttons.
5. Click any row label in a dimension table to drill in (the card title shows "Realization (drilled)"). Click **✕ Clear drill** in **Filters** to exit.
6. Export the current realization view with the **↓ CSV** link, or **⬇ Excel** on **Revenue operations**.
7. Optionally use **Ask in plain English** to ask a question; the answer includes **Open report:** pills that take you straight to the matching report view.

## Fields

- **Start** / **End** — date-range filter (note: these apply to realization; other cards use their own fixed windows).
- Realization dimension buttons — **firm**, **timekeeper**, **engagement**, **client**, **service line**.
- **Standard WIP** — original standard value; **After adjustments** — adjusted value; **Realization** — adjusted ÷ original, as a percent (green at ≥ 90%, otherwise amber).

## What you'll see

- **Revenue operations (last 90 days)**: **Billed**, **Paid**, **DSO**, **Collection rate**, **MRR (N plans)**, with sparklines and prior-period deltas. DSO turns amber above 60 days; collection rate amber below 80%. An **Accrual / Cash** toggle switches the 12-month sparkline trend between billed-by-issue-month and net-cash-collected-by-receipt-month.
- **Subscription profitability (trailing 90 days)**: per recurring plan, trailing revenue, in-scope/OOS hours, and a **Margin** pill (green ≥ 50%, amber ≥ 25%, else red).
- **Billable-hour targets · current month**: per-timekeeper **Hours**, **Variance**, **Attainment** (firm target default 130h).
- **Capacity forecast · next 4 weeks**: weekly average, projected 4-week hours, and a **Variance** pill vs the weekly target (default 32h).
- **Realization**: firm summary stats or a drillable dimension table sorted worst-realization first.
- Dedicated pages: **Payments Received** (`/reports/payments-received`) and **Engagement profitability** (`/reports/profitability`). Engagement profitability has its own **Accrual / Cash** basis toggle plus **Start**/**End** dates: accrual margin = billed − cost; cash margin = collected-in-window − cost.

## Detailed reports (the report viewer)

Many report-library tiles open the **report viewer** at `/reports/view/<report>` — a table view with its own controls:

- Where a report supports a window, enter **Start** / **End** dates (and any report-specific input) and click **Run**.
- Reports show **names, not raw IDs** — e.g. a partner, client, or engagement name instead of a long identifier.
- Export the table with **⬇ CSV** or **⬇ PDF** (the PDF mirrors the on-screen, formatted table).

See [[report-viewer]] for the full list of detailed reports and how to read them.

## Tips

- Filter settings persist in the page URL — copy the address bar to share an exact report view.
- Reports are gated by reporting permissions (e.g. `report:realization:read`, `report:profitability:read`, `report:utilization:read`, `report:partner-data:read`); payments-received needs `payment:read`.
- Click **✨ Explain this** under the firm realization stats for an AI narrative.
