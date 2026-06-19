---
title: 'Retainers'
slug: retainers-overview
category: retainers
audience: staff
tags: ['retainer', 'prepaid', 'tiers']
---

# Retainers

A retainer is a block of prepaid hours a client buys for a specific tax engagement. Eligible time logged against that engagement draws down the retainer instead of going to billable WIP. When the hours run out the retainer is `exhausted`; on its expiry date any unused hours forfeit. Retainers are firm-gated, sold in two tiers per return type, and visible to clients in the portal with a live balance and ledger. This is an opt-in feature — until a partner turns it on, no offers are created and the portal pages stay hidden.

## Steps

1. Turn the feature on at `/admin/retainer-tiers` (requires `retainer:tier_config:write` — partner-only). In **Firm-level retainer settings**, check **Feature enabled** (the pill flips to **ON**), then **Save settings**.
2. Set the offer rules: **Offer window (days from invoice date)** (default 60), the biller-toggle default, and the **Prep-fee work codes** set (lines on a tax-prep invoice with these codes count toward the offer basis).
3. Choose the **Reminder cadence** (**On-bill**, **Day 30**, **Day 55**) and optionally fill **GL revenue account** / **GL offset account**.
4. Configure tiers per return-type tab (`1040`, `1065`, `1120`, `1120S`, `1041`, `990`). Fill **Tier 1 — Standard** and **Tier 2 — Premium**, then **Save tiers**. Each tier needs at least one eligible work code.
5. Let offers auto-create on a qualifying tax-prep invoice, or create one manually on the partner dashboard (`/admin/retainers`) → **Create retainer**.
6. In the form, pick **Bill the client** (creates a sent AR invoice; retainer waits in `pending_payment` and activates when paid) or **Already paid (record only)** (active immediately). Select **Engagement** and **Tier**, optionally override **Hours** / **Price**, then **Create**.
7. Watch drawdown on the dashboard or in **My retainers** (`/my/retainers`). Open a retainer to see its ledger; export it as CSV.
8. Manage an active retainer from the dashboard: **Pause** (time routes to WIP), **Resume**, or **Void** (only when zero hours are consumed).

## Fields

- **Feature enabled** — master switch; off hides offers and portal pages but keeps the schema installed.
- **Hours covered** — prepaid hours for the tier.
- **Base fee ($)** + **Pct of prep fee (basis points, 100 = 1%)** — price = base fee + (pct × prep-fee basis).
- **Eligible work codes** — the work codes a retainer covers once activated (snapshotted at activation).

## What you'll see

- Dashboard KPIs: **Active**, **Tier 1/Tier 2 active**, **Hours sold/consumed (12mo)**, **Utilization**, **Expiring 90d**, **Open offers**, **Purchased/Declined/Expired 90d**.
- Status pills: `active`, `exhausted`, `paused`, `expired`, `void`, and `awaiting payment` (for `pending_payment`).
- In the portal, clients see hours purchased/consumed, expiry, status, a privacy-filtered ledger (no staff names or notes), and a downloadable Retainer Activity Statement PDF.
- Notification emails on activation, on exhaustion, and expiry warnings at 90/60/30/7 days before expiry.

## Tips

- Eligibility is locked in at activation: changing a tier's work codes later does not affect already-active retainers.
- One retainer per engagement. Void (zero hours only) to free the engagement for a new offer.
- A time entry only draws down when the retainer is `active`, the entry date is on or before the expiry date, and the work code is eligible; otherwise it goes to billable WIP.
- Editing or deleting a time entry reverses its consumption, and an exhausted retainer can flip back to `active`.
- Unused hours forfeit on the expiry date — no refund or rollover.
