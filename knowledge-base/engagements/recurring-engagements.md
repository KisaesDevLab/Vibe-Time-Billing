---
title: 'Recurring engagements & periods'
slug: recurring-engagements
category: engagements
audience: staff
tags: ['recurring', 'periods', 'rollover']
---

# Recurring engagements

## Steps

1. While creating an engagement, pick a **template**, then under **Recurrence** check **Make this engagement recurring** (disabled until a template is chosen).
2. Set: **Frequency** (Weekly / Biweekly / Monthly / Quarterly / Semiannual / Annual); **Trigger** — **On a schedule** or **When the current one closes**; **Next run date** (required for schedule); and an optional **Seed period** (year/month/label) for the first spawn.
3. Create the engagement; the recurrence is created right after.
4. Fire one manually with **Run now** on the client's **Engagements** tab (or Admin → Engagement recurrences).
5. Roll everything due at once with **Roll due recurrences** from the Clients list header.

## What you'll see

A recurrence is **ACTIVE** by default (you can pause or cancel it). A daily worker auto-spawns due recurrences. In the Roll-due dialog each row reports **spawned: {name}**, **approval queued**, **skipped**, or **error**.

## Auto-rollover collisions

If a scheduled recurrence fires while the previous period's engagement is still ACTIVE/PAUSED, it does **not** spawn — it queues an approval for the partner to decide (per the locked "notify the partner, partner decides" rule). On-completion recurrences never collide.

## Tips

- Keep period fields populated so the next period's name rolls cleanly.
- If recurrence setup failed during creation, add it later from the client's Engagements tab.
