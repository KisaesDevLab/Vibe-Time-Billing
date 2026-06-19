---
title: 'The worker-alert inbox'
slug: alerts-inbox
category: reporting
audience: staff
tags: ['alerts', 'anomaly', 'scope-creep', 'wip', 'ai', 'audit']
---

# The worker-alert inbox

The **Alerts** page (`/alerts`) collects background-worker alerts — the system's automated flags about anomalies and aging work.

## Who can do this

Gated by **admin:audit:read** (the alerts feed comes from the audit subsystem). Users without it won't see the page.

## Steps

1. Open **Alerts** from the navigation (`/alerts`).
2. Scan the table — **When**, **Kind**, **Subject**, **Summary**.
3. Type in **Search alerts…**, filter the **Kind** column, and sort by **When**. **Clear filters** resets active filters.
4. Click **Details** on a row to open the alert modal — it shows the kind, full timestamp, **Subject id** (truncated), and a **Full detail** JSON dump. **Close** dismisses it.
5. In the **AI summary** card, click **✨ Summarize these alerts** (it reads **Asking AI…** while working) to get a plain-language roll-up.

## Field reference — the four alert kinds

- **audit anomaly alert** — flagged anomaly from the audit trail.
- **scope creep alert** — engagement running out of scope.
- **wip age alert** — work-in-process aging past threshold.
- **engagement rollover** — a recurring engagement rolled to its next period.

Other columns: **Subject** shows a short entity reference (or "—"); **Summary** is the generated one-line description.

## Common errors

No form input means no validation. If the **✨ Summarize these alerts** button is absent, there are simply no alerts to summarize. If the whole page is unavailable, you lack **admin:audit:read**.

Related: [[anomaly-scope-creep]], [[audit-log]], [[reporting-overview]], [[report-viewer]]
