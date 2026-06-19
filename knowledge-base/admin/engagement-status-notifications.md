---
title: 'Engagement statuses & per-status client notifications'
slug: engagement-status-notifications
category: admin
audience: staff
tags: ['engagements', 'status', 'notifications', 'client', 'admin', 'messaging']
---

# Engagement statuses & per-status client notifications

**Admin → Engagement statuses** is your firm's catalog of board (progress) statuses. Beyond color and order, each status can carry client-facing text, be scoped to specific service lines, and — the key part — automatically **notify the client** when an engagement enters it. Built-in statuses can be edited but not deleted.

## Who can do this

Firm administrators with access to Admin settings.

## Steps

1. Open **Admin → Engagement statuses**.
2. Click **+ Add status** to create a custom one, or **Edit** on any row (including built-ins) to open the editor.
3. In the editor set the **Internal label (staff)**, **Color**, and **Board order**, choose **Service lines**, and under **CLIENT PORTAL** set the **Client label** / description and whether to **Show this status to clients**.
4. Under **CLIENT NOTIFICATIONS**, check **Notify the client when an engagement enters this status**, then choose a **Delivery** mode and **Methods**.
5. Quick toggles are available right on the table: **Show clients**, **Board**.

## Field reference

- **Internal label** / **Color** / **Board order** — how staff see the status on the board.
- **Client sees / Client label** — the text clients see; blank falls back to the "standard pill".
- **Show clients** — whether the status is visible in the portal at all.
- **Service lines** — leave none selected for **All** engagements, or pick lines to scope the status to them.
- **Notifies** (the table column) — shows the configured channel pills (**email / sms / portal**) plus the mode pill (**immediate** vs **approval**).
- **Delivery** — **Require approval** (STAGED — queued under Approvals to send now, schedule, or cancel) or **Send immediately** (IMMEDIATE).
- **Methods** — **Email**, **Text message**, **Portal notice** (one or more).
- **Recipients** — **Billing contact** or **All contacts**.

## Common errors

- **Can't delete a status** — it's a **built-in**; built-ins are editable but not deletable. Delete only applies to custom statuses.
- **"Pick at least one method or nothing will be sent."** — notifications are enabled but no method is checked.
- **Notification never reaches the client** — the status isn't notify-enabled, no method is selected, or with **Require approval** the queued notice was never released under Approvals.
- **A status missing for some engagements** — it's scoped to **service lines** that don't include that engagement.

Related: [[status-history]] [[staged-notifications-module]] [[notification-templates]] [[approvals-overview]]
