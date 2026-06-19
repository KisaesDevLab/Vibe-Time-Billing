---
title: 'Client & engagement rate overrides'
slug: rate-overrides
category: rates
audience: staff
tags: ['rates', 'override', 'client', 'engagement']
---

# Rate overrides & precedence

Beyond each staff member's standard billing rates, you can override a person's rate for a specific client, a specific engagement, or a service line. When a time entry is saved, the rate resolver walks these levels from most specific to least specific and uses the first one that matches and is in effect. This article explains the levels, the exact precedence order, and how effective dating breaks ties.

## Steps

1. Open the admin area and click **Rates** (`/admin/rates`).
2. To inspect or audit a person's overrides, find them in **Loaded margin** and click **History**. The **Rate history** dialog lists **Staff snapshots (per rate code)**, **Client overrides**, **Engagement overrides**, and **Service line rates**.
3. To confirm which level will win for a given situation, use the **Resolve-debug — why is this rate $X** panel: choose a **Timekeeper**, an **Engagement**, and a **Service date**, then click **Resolve**.
4. Read the **Trace** pills to see which level won and which were skipped, and expand **candidate(s) considered** to see every competing rate with its **Effective start** and **End**.

## Fields

- Override bill rate — every override level stores a bill rate per staff member.
- **Effective start** — the date the override begins to apply (required on all override types).
- **End** — optional close date (client overrides and service-line rates support one). An override applies when start ≤ service date < end.

## What you'll see

The resolver checks these levels in order and stops at the first match (most specific wins):

- **Engagement override** — this staff person on this engagement.
- **Client override** — this staff person on this client.
- **Service-line rate** — this staff person on the entry's service line.
- **Staff rate** — the staff snapshot entry for the engagement's **Default rate code**; if none exists, it falls back to the `StandardRate` entry (the trace shows `fallback`).
- **Firm default** — the final fallback. There is no firm-wide rate on the schema, so if nothing resolves the app refuses the time entry instead of billing zero.

## Tips

- There is **no work-code-level rate override**. Work codes affect in-scope tagging, not the rate; rate selection is driven by the engagement's rate code.
- When two rows at the same level are both in effect on the service date, the resolver picks the one with the most recent **Effective start**.
- Overrides are matched per staff member — an engagement or client override only applies to the specific person it was created for, not the whole team.
- Effective dating uses the entry's **service date**, not today's date, so backdated entries resolve against the rate that was in effect then.
- After the level wins, the engagement's premium/discount multiplier is applied to the resolved bill rate before it's snapshotted; the cost rate is never multiplied.
- Deleting an override is audit-logged and only affects future time entries — entries already saved keep their captured rate.
