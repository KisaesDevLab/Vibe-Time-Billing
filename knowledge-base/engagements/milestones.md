---
title: 'Milestones'
slug: milestones
category: engagements
audience: staff
tags: ['milestones', 'fixed fee', 'triggers']
---

# Milestones

Milestones apply to **FIXED_FEE_WITH_MILESTONES** engagements; the plan's amounts must sum exactly to the engagement's total fee.

## Statuses

- **PENDING** — not yet fired (only PENDING can be triggered).
- **TRIGGERED** — fired by date/event but not yet invoiced.
- **INVOICED** — billed; carries the invoice id (shown as a success pill).
- **CANCELLED** — voided.

## How they bill

- **Manual** — in **Admin → Milestones**, pick the engagement and click **Trigger** on a PENDING row. This creates a DRAFT invoice with one **Milestone** line ("Milestone: {name}") and flips the milestone to INVOICED.
- **Date** — a daily worker marks a PENDING date milestone TRIGGERED on its date (it does not auto-invoice — a person still triggers billing).
- **Event** — an engagement status change emits an event (e.g. `engagement.closed`) that flips matching PENDING milestones to TRIGGERED.

## What you'll see

The engagement detail page shows a **Milestones (N)** card (#, Name, Amount, Trigger, Status). Admin → Milestones shows the engagement's **Total fee** and a **Trigger** button on PENDING rows.

## Tips

- Only triggered milestones produce revenue — date/event triggers advance status but stop short of invoicing, so billing is always a deliberate step.
- If amounts don't sum to the total fee, plan creation is rejected.
