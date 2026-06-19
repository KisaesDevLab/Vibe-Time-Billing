---
title: 'Your booking availability'
slug: availability-windows
category: scheduling
audience: staff
tags: ['scheduling', 'availability', 'booking', 'buffers', 'calendar']
---

# Your booking availability

The **Availability** tab under **Appointments** (`/appointments#availability`) controls when you can be booked. Bookable slots are the **intersection** of the hours you set here with your connected calendar's free/busy — so blocking time on your calendar also removes it from booking.

## Who can do this

You edit your own availability; an admin can edit it for any staff member. The same editor appears on the admin staff profile.

## Steps

**Weekly hours**

1. Go to **Appointments → Availability**.
2. For each day, click **+ Add hours** and set the start and end **time**. Add multiple windows on one day for **split shifts** (e.g. a lunch break). Days with no window show "Unavailable".
3. Per window, optionally limit it: toggle **In-person / Phone / Video** to restrict meeting types (leave all unchecked = any), pick a default **location** from the dropdown, and toggle which appointment **Types** the window accepts (none selected = all).

**Buffers & booking rules** 4. Set **Buffer before (min)**, **Buffer after (min)**, **Minimum notice (hours)**, and **Slot increment (min)**. 5. Toggle **Enable booking on my calendar**. When off, you're hidden from the booking form's staff picker. 6. Click **Save booking settings**.

## Field reference

- **Window location toggles** — In-person / Phone / Video; empty = all allowed.
- **Window location dropdown** — a preset location applied to bookings made in that window.
- **Types** — appointment types the window accepts; empty = all types.
- **Buffer before / after** — minutes held free around each appointment (0, 5, 10, 15, 30).
- **Minimum notice (hours)** — how far ahead a slot must be (1, 2, 4, 8, 24, 48).
- **Slot increment (min)** — granularity of offered start times (15, 30, 60).
- **Enable booking on my calendar** — master on/off for being bookable.

## Common errors

- **"I have hours set but no slots show"** — your connected calendar is busy during those hours, your minimum notice rules them out, or **Enable booking on my calendar** is off.
- **Nobody can pick me in the booking form** — the booking toggle is off.

Related: [[connect-your-calendar]] [[public-booking-setup]] [[booking-appointments]] [[appointment-types]]
