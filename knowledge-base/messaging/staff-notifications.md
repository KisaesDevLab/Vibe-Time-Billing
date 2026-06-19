---
title: 'Your in-app Notifications inbox'
slug: staff-notifications
category: messaging
audience: staff
tags: ['notifications', 'inbox', 'calendar', 'appointments', 'reschedule']
---

# Your Notifications inbox

The **Notifications** page (`/notifications`) is your personal in-app notification center. It surfaces events that need your attention — chiefly around appointments and calendar sync.

This is **not** the same as notification _templates_ (the email/SMS content engine — see [[notification-templates]]) or _staged client notifications_ (the approval-gated client send pipeline — see [[staged-notifications]]). This inbox is just for you, the staff member.

## Who can do this

Any signed-in staff user has their own Notifications inbox; it shows only your notifications.

## Steps

1. Open **Notifications** (`/notifications`). The header shows **Notifications** with an unread count.
2. Read the **Recent (n)** list — each item shows a kind pill, a **title** (bold while unread), an optional body, and a timestamp.
3. On an item, use **Open** (jumps to the related screen, when a link exists), **Read** (marks it read — shown while unread), or **Dismiss** (always available).
4. Use **Mark all read** in the header to clear the unread count at once.

## Field reference — notification kinds

- **reschedule requested** — a client asked to reschedule an appointment.
- **appointment cancelled by client** — a client cancelled a booking.
- **provider write failed** — a calendar (M365/Google) write failed and needs attention.

Status values are UNREAD / READ / DISMISSED / ACTIONED; read/dismissed items appear dimmed.

## Common errors

There's no form to validate. When the list is empty it reads **You're all caught up.** A **provider write failed** notice usually points to a calendar connection problem — see [[connect-your-calendar]].

Related: [[notification-templates]], [[staged-notifications]], [[connect-your-calendar]], [[booking-appointments]], [[dashboard-overview]]
