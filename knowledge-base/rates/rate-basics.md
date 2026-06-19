---
title: 'Rate codes and standard rates'
slug: rate-basics
category: rates
audience: staff
tags: ['rates', 'rate code', 'standard rate']
---

# Billing rates basics

Every billable time entry needs an hourly billing rate. This article explains where rates come from, how the app picks the right one for a time entry, and why the rate is locked in the moment the entry is saved. Rate setup lives in the admin area under **Rate codes**, **Rates**, and each staff member's detail page.

## Steps

1. Open the admin area and click **Rate codes** (`/admin/rate-codes`).
2. Review the rate-code catalog. Every firm has a system-seeded `StandardRate` code (shown with a `system` pill); it is the resolver fallback and cannot be renamed, deactivated, or deleted.
3. To add a code, fill **Code**, **Description**, and **Sort**, then click **Add**. Codes edit inline and save with **Save**.
4. To set a staff member's rates, go to **Users**, open a person, and select the **Rates** tab.
5. Under **Effective-dated billing rates**, click **+ New effective period**.
6. Enter an **Effective date** and **Cost / hr ($)**, then a **$ / hr** billing rate for each rate code. `StandardRate` is required on every snapshot.
7. Click **Save snapshot**. Snapshots are append-only — to change a rate later, add another effective period; you never edit a saved one.
8. To check what a time entry will bill at, open **Rates** (`/admin/rates`) and use the **Resolve-debug — why is this rate $X** panel.

## Fields

- **Code** — the rate code name (e.g. `StandardRate`, `PayrollServices`).
- **Effective date** — the date a snapshot's rates begin to apply.
- **Cost / hr ($)** — what the firm pays this person per hour (one cost rate per snapshot).
- **$ / hr** — the billing rate for each rate code in the snapshot.
- **StandardRate** — required on every snapshot; used when an engagement's rate code has no matching entry.

## What you'll see

- The user **Rates** tab shows a **Current cost rate** card and the list of effective-dated billing rates.
- The **Rates** admin page shows **Loaded margin (current StandardRate vs cost)** with **Bill**, **Cost**, **Margin**, and **Effective** columns, plus `cost missing` and `low margin` pills.
- Resolve-debug shows **Won at level**, **Resolved rate**, **Engagement multiplier**, **Effective (multiplied)**, and a trace of each level's `win` / `no-match` / `fallback` status.

## Tips

- A time entry captures its rate at the moment of creation — the bill rate, the line amount (hours × rate), and the cost rate are all snapshotted onto the entry. Changing a staff rate later never reprices past entries, so historical reports never shift.
- The engagement's **Default rate code** decides which staff-rate code the resolver looks for; if there's no entry for that code, it falls back to `StandardRate`.
- An engagement premium/discount multiplier is applied to the bill rate before the snapshot is stored, so a discounted entry saves at the discounted rate. The multiplier never changes the cost rate.
- If no rate resolves for a person on an engagement, the app refuses the time entry rather than billing at zero — make sure every staff member has at least a `StandardRate` snapshot entry.
- Use **Bulk update (StandardRate, all staff)** on the **Rates** page to raise everyone's StandardRate by a percentage on a chosen effective date.
