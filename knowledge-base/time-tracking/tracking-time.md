---
title: 'Logging time'
slug: tracking-time
category: time-tracking
audience: staff
tags: ['time', 'time entry', 'log']
---

# Logging time

Log billable and non-billable time on the staff **Time** page (`/time`), which opens on the **Quick log** tab.

## Steps

1. Open **Time** from the sidebar. You're on the **Quick log** tab (other tabs: **Day**, **Week**, **Month**).
2. In the **Log time** card, pick a **Client** (active clients only; pinned clients sort to the top with a star).
3. Pick an **Engagement** — the list is filtered to that client's open engagements. If there's exactly one, it's auto-selected and shows "(auto-selected)".
4. Set the **Date** (defaults to today) and **Hours** (defaults to `1.00`).
5. Optionally choose a **Work code** (clearable; "— none —").
6. Type a **Description** ("What you worked on"). If AI is on, a **Describe this entry** panel offers **Suggest** / **Regenerate**.
7. Optionally tick **Out of scope** to flag the entry for review.
8. Click **Log** (shows "Saving…").

## Fields

- **Engagement** — required (`engagementId`). Without it: "Pick a client + engagement first."
- **Date** — required (`entryDate`, YYYY-MM-DD).
- **Hours** — required; positive, max `24`; the input steps by `0.25`.
- **Work code** — optional.
- **Description** — optional, up to 2000 characters.
- Your firm may set **required-field rules**; if a rule's fields are missing the save is rejected naming the rule.

## How the rate is set

The billable rate is **resolved at save** (engagement override → client override → service-line rate → your staff rate → firm default), any engagement multiplier is applied, and the resulting rate and amount are **snapshotted onto the entry** — so later rate changes never alter past entries. If no rate resolves, the save is refused.

## What you'll see

On success Hours resets to `1.00`, the form clears, and **My entries** reloads with the new row (Date, Client, Engagement, Hours, Amount, Flags, Description). Flags include **billable**/**non-bill**, **OOS**, and **billed** (once locked).

## Tips

- You can't log time to a PAUSED, CLOSED, ARCHIVED, or retainer-locked engagement.
- Back-dated entries older than the firm's late-entry lockout window are refused.
