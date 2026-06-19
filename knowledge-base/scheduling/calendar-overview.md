---
title: 'Admin calendar overview'
slug: calendar-overview
category: scheduling
audience: staff
tags: ['calendar', 'scheduling', 'admin', 'appointments', 'sync', 'csv']
---

# Admin calendar overview

**Admin → Calendar overview** gives a firm-wide view of synced appointments across all staff, plus a health check on each staff member's calendar connection. Use it to spot appointments that didn't match to a client and to find connections that are read-only or failing to sync.

## Who can do this

Firm administrators with access to Admin settings.

## Steps

1. Open **Admin → Calendar overview**.
2. In **All-staff appointments**, filter by **Staff**, **From**, and **To**; **Clear** resets the filters.
3. Click **Export CSV** to download the currently filtered list.
4. Review **Connection health** below for each staff member's provider, last sync, and write capability.

## Field reference

All-staff appointments table:

- **When / Staff / Event / Client** — appointment time, owner, subject, and the matched client.
- **Match tier** — how confidently the appointment was matched to a client.
- **Match** — **confirmed** (success pill) vs unconfirmed (warning pill).

Connection health table:

- **Provider** — the calendar provider and connected email.
- **Status** — **OK**, **Disabled**, or a red pill showing the sync error.
- **Last synced** — timestamp of the last successful sync, or **never**.
- **Write-back** — **enabled** (we can create/update events) vs **read-only** (we can only read). A banner warns when one or more connections are read-only.

## Common errors

- **read-only connections** — appointment write-back needs the staff member to reconnect and grant calendar **write** access; the banner counts how many are affected.
- **Last synced: never / a sync error pill** — the connection failed; have that staff member reconnect their calendar.
- **No appointments** — no synced events match the current filters; widen the date range or clear the staff filter.

Related: [[scheduling]] [[integrations-overview]]
