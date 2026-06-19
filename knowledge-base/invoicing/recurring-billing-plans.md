---
title: 'Recurring billing plans'
slug: recurring-billing-plans
category: invoicing
audience: staff
tags: ['recurring', 'billing plan', 'subscription', 'retainer', 'autopay', 'recurring billing']
---

# Recurring billing plans

A **recurring billing plan** bills a single engagement automatically on a schedule. Each time it runs, a background worker creates a billing batch and a **DRAFT invoice** for that engagement, then advances the plan to its next date. Use it for repeating fees — monthly bookkeeping, a quarterly advisory retainer, an annual subscription.

> A recurring billing **plan** generates _invoices_ for an existing engagement. A [[recurring-engagements]] **recurrence** generates new _engagement periods_. They're different features and can be used together (a recurrence spawns the Jan engagement; a plan on it bills every month).

## Where to find it

- **Billing → Recurring plans** in the left nav (`/recurring-plans`) — the firm-wide view: a health summary (Active / Paused / Cancelled counts + how many are due in the next 7 days), the create form, and the table of all plans.
- A **Recurring plans** card on an individual **engagement** detail page — lists the plans on that engagement and lets you add one pre-scoped to it.

(The nav item shows for staff with engagement access.)

## Create a plan

1. Open **Billing → Recurring plans** (or the engagement's Recurring plans card).
2. Pick the **Engagement** (already filled in when you start from the engagement card).
3. Choose a **Frequency**: Weekly, Biweekly, Monthly, Quarterly, Semiannual, or Annual.
4. Enter the **Amount** (the fixed fee billed each cycle).
5. Optionally set a **Billing day of month** (1–31).
6. Set the **Next run date** — the first date the plan should bill (defaults to the first of next month).
7. **Create plan.** It starts **ACTIVE**.

## What happens when it runs

A daily worker picks up every ACTIVE plan whose **next run date** is today or earlier and, for each:

- **Fixed-fee / subscription engagements** — bills the plan's **Amount**.
- **Hourly engagements** — instead rolls up the period's **unbilled time** into the bill (if there's no unbilled time it bills nothing but still advances the schedule, so the cadence never stalls).
- Creates an **approved billing batch** and a **DRAFT invoice** (with a due date from the client's terms). The invoice is left in DRAFT for you to review and send.
- Advances **Next run date** by one cycle. Runs are idempotent — a retry won't double-bill the same period.

## Autopay

If the plan (or the engagement) has autopay set up with a saved payment method, the new invoice is charged automatically after it's created; on success it's marked PAID. After several consecutive failed charges the plan **auto-pauses** and the partner is emailed.

## Manage a plan

From the plans table:

- **Run now** — pulls a plan into the next worker tick instead of waiting for its date.
- **Pause** (reason required) / **Resume** — stop and restart future runs. Pausing never credits past charges; it only stops upcoming bills.
- **Edit** — change amount, frequency, or next run date.
- **Proration preview / commit** — for a mid-cycle price change, preview the credit/debit for the remaining days, then commit it (updates the amount and creates a proration invoice).
- **Duplicate** — clone a plan as a fresh ACTIVE one.
- **Cancel** — a terminal stop (can't be resumed; duplicate to start over).
- The plan also tracks the **invoices it has generated**, so you can see its billing history.

## Tips

- One plan bills one engagement. For a client with several engagements, add a plan to each.
- The invoice lands as **DRAFT** — recurring plans create the bill; sending it is still your call (unless autopay is on).
- Pausing is the safe way to hold billing during a dispute or seasonal gap without losing the schedule.

Related: [[fee-structures]], [[recurring-engagements]], [[creating-invoices]], [[payment-setup]].
