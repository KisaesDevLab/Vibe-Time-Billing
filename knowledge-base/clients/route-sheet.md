---
title: 'Printing a File Routing Sheet'
slug: route-sheet
category: clients
audience: staff
tags: ['route sheet', 'print', 'engagements', 'status', 'workflow']
---

# Printing a File Routing Sheet

A **File Routing Sheet** is a printed cover sheet for a client's open engagements — it lists the engagement, the assigned partner/manager/staff, and the current status, so a physical file can be routed through the office. You print it from the client list, and you can change engagement statuses at the same time.

## Steps

1. On the **Clients** list, choose **Print route sheet** for a client.
2. The dialog lists the client's **uncompleted** engagements. Select the ones to print.
3. Optionally change each selected engagement's **status** from the dropdown, and add a **note** that applies to the sheet.
4. Click **Print**. Status changes are committed through the normal path — they're audited and will trigger any configured client notifications — and a PDF is produced (one per engagement) from a snapshot of the details.

## Reprints

Each print is logged. Open the client's **print history** to reprint any prior sheet; it re-renders from the saved snapshot, so it shows exactly what was printed even if the engagement has since changed.

## Tips

- Completed, cancelled, closed, and archived engagements are excluded from the sheet.
- Because status changes here are real changes, they flow into [[staged-notifications]] if you've configured client notifications for those statuses.
- For a single-engagement processing form printed from the time-entry view, see [[process-project-sheet]].
