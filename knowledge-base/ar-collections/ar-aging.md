---
title: 'AR aging'
slug: ar-aging
category: ar-collections
audience: staff
tags: ['ar', 'aging', 'receivables']
---

# AR aging & statements

The AR (accounts receivable) area shows every client's outstanding invoice balance, bucketed by how far past due it is, and lets you generate or email a statement of account. Open it from the **AR** item in the left navigation (the `$` icon, route `/ar`). Only invoices in `SENT`, `PARTIALLY_PAID`, or `OVERDUE` status count toward AR; `DRAFT`, `PAID`, and `VOIDED` invoices are excluded. Each invoice's balance is its total minus the amount paid, and rows with a zero-or-negative balance drop out automatically.

## Steps

1. Open **AR** from the left nav. The top card reads **AR aging as of <date>** with a `live` pill.
2. Read the four bucket totals: **0-30 days**, **31-60 days**, **61-90 days**, **90+ days**, plus a **Total**. The **90+** figure is shown in red.
3. In the **By client** card, narrow the list with the **Any owner** filter and/or the **Any client** filter.
4. Sort by clicking any column header (**Client**, **0-30**, **31-60**, **61-90**, **90+**, **Total**); click again to flip direction.
5. Page through results with **← Prev** / **Next →**, and set rows per page with the **50** / **100** / **200** selector.
6. To pull one client's statement, click the **Statement** button on that row — it downloads a statement-of-account PDF.
7. To act on many clients, tick the row checkboxes (or **Select all**). A bar shows **N clients selected** with **Generate statements (PDF)** (one combined PDF) and **Email statements** (emails each client's billing contact).
8. For a balance trend over time, go to `/ar/snapshots` — the **AR aging snapshot trend** card lists each **As of** date with the change vs. the prior snapshot.

## Fields

- **0-30**, **31-60**, **61-90**, **90+** — aging buckets measured in days past each invoice's due date.
- **Total** — the client's full outstanding balance across all buckets.
- **As of** — the snapshot or report date.

## What you'll see

- Balances roll up per client, then per firm for the top totals.
- The aging report exports to CSV and Excel (columns **Client**, **PartnerId**, **0-30**, **31-60**, **61-90**, **90+**, **Total**).
- A single-client statement lists each open invoice as an **Invoice** row plus any **Payment** credit rows, with a running balance, and a five-band aging summary (**0-30**, **31-60**, **61-90**, **91-120**, **121+**) — a finer split than the four-bucket aging report.
- Statements carry firm branding (logo, accent color, support contacts) and a policy notice that work is suspended on balances over 90 days past due. The A/R Terms text from firm settings prints in the footer.
- Bulk generate/email skips clients with no outstanding balance and reports how many were generated vs. skipped.

## Tips

- A nightly job snapshots per-client aging (around 12:30 AM) — the trend page is empty until it has run at least once.
- Statements and the aging report read the same balances, so the numbers always agree.
- Bulk actions cap at 200 clients per request; email is skipped for any client without a billing-contact email.
- Set the A/R Terms and branding under **Admin → Firm settings** so statements render correctly.
- Viewing AR requires the `report:ar:read` permission.
