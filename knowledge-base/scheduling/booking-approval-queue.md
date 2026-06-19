---
title: 'Approving public booking requests'
slug: booking-approval-queue
category: scheduling
audience: staff
tags: ['scheduling', 'booking-requests', 'approve', 'decline', 'queue']
---

# Approving public booking requests

When a visitor requests a time on a public booking page, it lands in the **Booking requests** inbox (`/appointments#requests`) as a pending _hold_, not a confirmed appointment. Approving it creates the appointment; declining records a reason and emails the visitor.

## Who can do this

Only an **approver** for the originating booking page (or, if a page has no approvers, that page's staff member). Acting on a request you don't approve for returns "You are not an approver for this booking page."

## Steps

1. Open **Appointments → Booking requests**. The header shows the pending count; each request is a card with the requested time, the **Staff** member, the **Visitor** (name, email, phone), any **Notes**, and when the **Hold expires**.
2. Click **Approve** to create the appointment from the request.
3. To turn it down, click **Decline**, optionally type a reason (it's emailed to the visitor), then **Confirm decline**.

## Field reference

- **Hold expires** — when the held slot lapses if no one acts; expired requests free the slot.
- **Approve** — converts the request into a real appointment on the staff member's calendar.
- **Decline** + reason — rejects the request and notifies the visitor.

## Common errors

- **"That time is no longer available — the slot was taken."** — the slot filled (or your calendar got busy) between the request and your approval; the request can't be approved.
- **"You are not an approver for this booking page."** — you're not on that page's approver list; ask an approver or an admin to add you.

Related: [[public-booking-setup]] [[availability-windows]] [[booking-appointments]]
