---
title: 'Scope creep & anomaly detection'
slug: anomaly-scope-creep
category: reporting
audience: staff
tags: ['scope creep', 'anomaly', 'alerts']
---

# Scope-creep & anomaly detection

The app watches for engagements drifting out of scope and for unusual activity, and surfaces the results in two places: the live **Reports** workspace and the **Alerts** inbox (`/alerts`). Detection runs both on-demand (report endpoints) and in background workers that write immutable alert events into the audit log.

## Steps

1. For a live view, open **Reports**; the scope-creep report ranks mixed-mode engagements by out-of-scope share of total hours.
2. To review flagged events, open **Alerts** from the left navigation (gated by the `admin:audit:read` permission).
3. Read the **Inbox · worker alerts** table for **scope creep**, **audit anomaly**, **wip age**, and **engagement rollover** rows.
4. Triage with the **When**, **Kind**, **Subject**, and **Summary** columns; the **Subject** is the affected engagement or actor. Use the **Search alerts…** box, the per-column sort, and the **Kind** filter to narrow the list.
5. Click **Details** on any row to open a modal with the alert's full pretty-printed JSON payload.
6. Optionally click **✨ Summarize these alerts** in the **AI summary** card for a plain-language rollup.

## Fields

- Scope-creep metrics: **totalHours**, **outOfScopeHours**, and **creepPct** (out-of-scope ÷ total), sorted highest first.
- Scope-creep alert payload: creepPct, windowDays, totalHours, outOfScopeHours, threshold.
- Audit-anomaly alert payload: actor kind (staff/portal), actor id, events-last-hour, threshold.

## What you'll see

- A **scope creep** alert summary like "23.4% out-of-scope hours over 30d" with an amber pill.
- An **audit anomaly** alert when an actor exceeds N events/hour, with a red pill.
- The **Realization** report flags low realization (green at ≥ 90%, otherwise amber) — the realization "anomaly" lens for write-down drift.
- A time-anomaly report highlights days where a timekeeper's daily hours deviate sharply from their own 90-day pattern.
- Alerts are read-only and immutable — they live in the append-only audit log.

## Tips

- Scope-creep: the worker scans `ACTIVE` mixed-mode engagements over a 30-day lookback and fires when out-of-scope share is at or above the threshold (default 20%). The same engagement is suppressed for 7 days after an alert.
- Audit-anomaly: an actor exceeding ~80 audit events in the last hour is flagged (default), with 1-hour per-actor suppression.
- Time-entry anomaly detection flags daily hours at or beyond 2.5 standard deviations from the timekeeper's own 90-day mean (needs at least 5 active days to evaluate).
- Only mixed-mode engagements are scoped for creep — out-of-scope tagging comes from per-entry in-scope flags set at time-entry creation.
- An AI scope-creep narrative can turn the flagged list into a partner-facing summary plus one recommendation, when an AI provider and budget are available.
