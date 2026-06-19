---
title: 'Fee structures'
slug: fee-structures
category: engagements
audience: staff
tags: ['fees', 'billing', 'fixed fee', 'hourly', 'subscription']
---

# Fee structures

Every engagement has exactly one fee structure, chosen at creation (editable later). It determines how the engagement bills. The five values are:

- **HOURLY** — time-and-materials; billable time aggregates onto the invoice at each timekeeper's snapshotted rate.
- **HOURLY_NTE** — hourly with a "not to exceed" hard cap. Choosing it exposes the **NTE cap ($)** field; the cap can apply per period or for the lifetime.
- **FIXED_FEE** — a flat fee (held in **Fee amount ($)**). Time is still tracked for realization/budget, but the invoice is the fixed amount.
- **FIXED_FEE_WITH_MILESTONES** — a fixed fee split into milestones that each bill as their own invoice line when triggered (the plan must sum to the total fee).
- **RECURRING_SUBSCRIPTION** — a repeating flat fee (e.g. monthly bookkeeping/payroll); billing batches handle these via the recurring path.

## What you'll see

**Fee structure** is a dropdown of these values on the create form; **NTE cap ($)** appears only for HOURLY_NTE; **Fee amount ($)** applies to the fixed-fee structures. You can filter the Engagements list by fee structure.

## Tips

- If a structure isn't selectable, an admin has disabled it.
- Subscription "included hours" / per-employee overage are configured via template/recurring settings, not as separate fee structures.

> Note: the product is sometimes described as "seven fee structures," but the implemented set is the five above. Mixed-mode is the **Mixed-mode** toggle on a subscription engagement, and prepaid "hour bank" behavior is configured via retainers — they are options on these structures rather than separate selections.
