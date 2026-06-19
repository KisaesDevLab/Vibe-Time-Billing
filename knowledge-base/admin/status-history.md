---
title: 'Engagement status-change history report'
slug: status-history
category: admin
audience: staff
tags: ['engagements', 'status', 'history', 'report', 'audit', 'admin']
---

# Engagement status-change history report

**Admin → Status history** shows every engagement progress-status change across the whole firm in one list — who made it, when, and what it changed from and to. Use it to answer "who moved this engagement to _Filed_ and when," or to audit how work flowed through your board over a period.

## Who can do this

Firm administrators with access to Admin settings. The report is read-only.

## Steps

1. Open **Admin → Status history** (the "Status change history" card).
2. Optionally set a **From** and **To** date and click **Apply** to load changes in that window.
3. Optionally type into **Filter by person** ("name contains…") to narrow to a single staff member; this filters the loaded rows live, no reload needed.

## Field reference

- **When** — the timestamp of the change, in your local time.
- **Engagement** — the engagement name (falls back to a short ID if unnamed).
- **Who** — the staff member who made the change, or **System** for automated transitions.
- **Change** — the from-status pill → the to-status pill (uses the configured labels).
- **From / To** date filters — server-side window; **Apply** reloads.
- **Filter by person** — client-side substring match on the actor name.

## Common errors

- **No rows after Apply** — there were no status changes in that date window, or the window is too narrow. Widen the dates.
- **Person filter shows nothing** — the filter is a substring of the _actor_ name only; automated "System" changes won't match a person name.
- The report loads up to 1000 rows; tighten the date range if you expect more.

Related: [[engagement-status-notifications]] [[audit-log]] [[reporting-overview]]
