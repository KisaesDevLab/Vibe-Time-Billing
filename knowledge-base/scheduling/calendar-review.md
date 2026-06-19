---
title: 'Calendar review — matching unmatched events'
slug: calendar-review
category: scheduling
audience: staff
tags: ['scheduling', 'calendar', 'unmatched', 'review', 'matching']
---

# Calendar review — matching unmatched events

When the app syncs your connected calendar, it tries to match each event to a client. Events it can't confidently match queue up in **Calendar review** (`/appointments#review`) so you can confirm or correct the match. The tab shows a badge with the number waiting.

## Who can do this

Staff who own the connected calendar (and admins) work this queue.

## Steps

1. Open **Appointments → Calendar review**. Each row shows the **Event** (subject, time, organizer) and a **Suggested client** with a confidence percentage, when the app has a guess.
2. Choose an action:
   - **Confirm** — accept the suggested client (only shown when there is one).
   - **Pick client** — search and select the correct client yourself, then it's matched.
   - **Create client** — turn the event into a new client record.
   - **Dismiss** — clear the event from the queue without matching it.

## Field reference

- **Suggested client + %** — the app's best-guess client and its confidence score (higher = more certain).
- **Confirm** — accepts that suggestion.
- **Pick client** — opens an inline search (type 2+ characters) to choose any client.
- **Create client / Dismiss** — promote to a new client, or drop the event from review.

## Common errors

- **No suggestion shown (—)** — the app couldn't guess; use **Pick client** or **Create client**.
- **Low confidence %** — treat it as a hint, not a certainty; verify before you **Confirm**.
- **"Nothing to review — all appointments are matched."** — the queue is empty.

Related: [[connect-your-calendar]] [[availability-windows]] [[booking-appointments]]
