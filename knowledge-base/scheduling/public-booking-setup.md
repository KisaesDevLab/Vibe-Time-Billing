---
title: 'Setting up a public booking page'
slug: public-booking-setup
category: scheduling
audience: staff
tags: ['scheduling', 'booking-page', 'public', 'self-booking', 'setup']
---

# Setting up a public booking page

A **public booking page** is a URL you can share so visitors request a time without logging in. Requests are _holds_, not confirmed appointments — a staff approver must confirm each one. Set pages up under **Appointments → Booking page** (`/appointments#booking-page`).

## Who can do this

Staff manage their own booking page from the Appointments tab. The page is for a specific staff member's calendar.

## Steps

1. Open **Appointments → Booking page** and click **New booking page** (or **Edit** an existing one). Each page row shows a copyable **Public URL** (use **Copy**).
2. **Page settings:** set an optional **Custom slug** (auto-generated if blank), choose **Allowed appointment types** (blank = all), write a **Custom message** shown on the public page, and set **Default duration (min)**, **Slot increment (min)**, **Minimum notice (hours)**, **Buffer before/after (min)**, **Hold expiry (hours)**, and an optional **Daily cap**. Toggle **Require captcha** and **Active**.
3. **Availability windows:** add weekly windows (day + start/end time) and optionally restrict **Contact types** (In-person / Phone / Video; none = any).
4. **Approvers:** pick staff who may approve/decline this page's requests. If none, the page's staff member decides.
5. **Notify on new request:** add staff and choose **EMAIL** and/or **SMS** to alert them when a request arrives.
6. Click **Create page** / **Save changes**.

## Field reference

- **Custom slug** — the tail of the public URL; must be unique.
- **Hold expiry (hours)** — how long a pending request holds its slot before lapsing (default 72).
- **Daily cap** — max requests/day for the page (blank = no cap).
- **Require captcha** — bot protection on the public form (default on).
- **Active** — whether the public URL works.
- **Approvers / Notify** — who can confirm requests, and who gets pinged about new ones.

## Common errors

- **"That custom slug is already taken."** — another page uses it; pick a different slug.
- **Visitors see no open times** — the page's windows don't overlap the staff member's calendar free/busy, or minimum notice / daily cap is blocking them.
- **No one is alerted to requests** — add staff under **Notify on new request**.

Related: [[booking-approval-queue]] [[availability-windows]] [[appointment-types]]
