---
title: 'Saved reports & scheduled email'
slug: saved-reports
category: reporting
audience: staff
tags: ['reports', 'saved', 'scheduled', 'email']
---

# Saved reports

A saved report stores a report configuration — a name, a report kind, and a `params` payload — so you can rerun it later or share it firm-wide. Manage them under **Admin → AI & Integrations → Saved reports** (`/admin/saved-reports`).

## Steps

1. Go to **Admin**, open the **AI & Integrations** group, and click **Saved reports**.
2. In the **Save a report definition** card, type a **Name**.
3. Choose a **Report kind**: `realization`, `profitability`, `utilization`, `effective-rate`, `dso`, `mrr`, `book-of-business`, `clv`, `scope-creep`, or `revenue-period-over-period`.
4. Enter **Params JSON** — a JSON object of filters for that kind, e.g. `{"dimension":"timekeeper"}` or `{"days":30}`. Leave it as `{}` for defaults.
5. Tick **Shared firm-wide** to let other staff see it (read-only); leave it unticked to keep it private.
6. Click **Save**.
7. Review existing definitions in the **Saved reports** table; click **Delete** to remove one you own.

## Fields

- **Name** — label for the definition (1–120 characters).
- **Report kind** — which report the params apply to.
- **Params JSON** — a JSON object; invalid JSON shows "Params JSON is invalid" and blocks saving.
- **Shared firm-wide** — when on, the report shows a `firm-wide` pill; otherwise `private`.

## What you'll see

- The **Saved reports** table lists **Name**, **Kind**, **Params** (the raw JSON), **Shared** (a `firm-wide` or `private` pill), and a **Delete** action.
- You see your own saved reports plus any marked shared by colleagues.
- Editing or deleting is owner-only.

## Tips

- Scheduling is via the params payload, not a dedicated UI: a background worker scans saved reports for a `schedule` block of the shape `{ "schedule": { "enabled": true, "recipients": ["a@firm.com"], "cron": "..." } }` and emails the named recipients a deep link that opens the report with the saved filters applied. The cron's day-of-month/month/day-of-week fields are honored (minute/hour follow the worker's own schedule), and a report sends at most once per day.
- Scheduled emails send only when a mail provider is configured; otherwise the worker logs a no-op.
- To rerun, recreate the filters in the report itself using the saved **Params JSON** as your guide — the keys mirror the report's own query parameters (e.g. `dimension` for realization, `days` for windowed reports).
- Keep shared reports generic; private reports are best for ad-hoc param experiments.
