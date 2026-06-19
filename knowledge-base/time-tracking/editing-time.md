---
title: 'Editing, deleting, and locking time'
slug: editing-time
category: time-tracking
audience: staff
tags: ['time', 'edit', 'delete', 'lockout']
---

# Editing & locking time

Edit or delete your **own** entries from **My entries** until they're locked or billed.

## Steps

1. On **Time → Quick log**, find the row in **My entries**.
2. Click **Edit** — Hours, Description, and the **billable** / **OOS** checkboxes become inline-editable (editing one row disables Edit on others).
3. Adjust fields (Hours must be positive, ≤ 24) and click **Save** ("Saving…") or **Cancel**.
4. To remove an entry, click **Delete** and confirm "Delete this time entry?" — this soft-deletes (archives) it.

## What changes

- Editable: Hours, Description, Work code, billable flag, out-of-scope override.
- The **rate snapshot does not change** on edit; when hours change the amount is recomputed as the original rate × new hours.
- Every edit and delete is **version-stamped** (prior values kept) for audit — nothing is truly erased.

## When you can't edit

- Only **your own** entries (others return "forbidden").
- An entry becomes **read-only once locked or attached to a billing batch** — **Edit**/**Delete** disappear and the row shows a **billed** pill.

## Late-entry lockout

When creating an entry, the firm's late-entry window applies (default **14 days**, configurable). Entries dated before the cutoff are refused as "late entry locked." Set 0 to disable.

## Tips

- Logged to the wrong engagement? Moving an entry between engagements is a manager/partner action, not a self-service edit.
