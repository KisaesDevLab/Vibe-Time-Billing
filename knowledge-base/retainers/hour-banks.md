---
title: 'Hour banks'
slug: hour-banks
category: retainers
audience: staff
tags: ['hour bank', 'prepaid hours', 'rollover', 'forfeit']
---

# Hour banks

An hour bank is a prepaid block of hours attached to an engagement, drawn down as work is performed. Unlike retainers (which target a tax return and two fixed tiers), an hour bank is a simple ledger: an opening balance plus top-ups, minus debits, expirations, and forfeitures. The balance is always computed from the transaction ledger — opening hours never change. Residual hours forfeit when the engagement closes (no refund, no credit). The staff web app provides read-only **Hour banks** and **Hour-bank transactions** views; most actions run through the API.

## Steps

1. View banks on the **Hour banks** page (requires `engagement:read`). Each row shows the client, engagement, opening hours, opening amount, expiry, and status.
2. Create a bank with an engagement, opening hours, opening amount, and optional rollover cap / expiration date (requires `engagement:write`).
3. Check a balance — remaining = opening + `PURCHASE` top-ups − (`DEBIT` + `EXPIRE` + `FORFEIT`).
4. Draw down hours with a debit; a debit larger than the available balance is rejected with `insufficient_hours`.
5. Top up — writes a `PURCHASE` transaction tagged `manual_top_up`.
6. Configure auto-replenish — enable it, set a threshold and a target, and optionally a rollover cap.
7. Forfeit residual on close (requires `engagement:archive`) — writes a `FORFEIT` transaction for the remaining balance, zeros the running balance, and stamps a forfeited timestamp. A bank can only be forfeited once.
8. Review history on **Hour-bank transactions** — pick a bank from the **Hour bank:** dropdown and read the ledger.

## Fields

- **Opening hours / amount** — the starting balance and its dollar value; never mutated.
- **Rollover cap** — ceiling the post-replenish balance is clamped to; auto-replenish never pushes above it.
- **Expiration date** — date after which the daily worker expires the remaining balance.
- **Auto-replenish threshold / target** — when the balance drops below the threshold, the worker refills it to the target.

## What you'll see

- On **Hour banks**: an `ACTIVE` pill, or a `FORFEITED` pill once forfeited or expired. Expiry shows `—` when none is set.
- On **Hour-bank transactions**: columns **When**, **Kind**, **Hours**, **Amount**, **Running**, **Note**. Transaction kinds are `PURCHASE`, `DEBIT`, `EXPIRE`, `FORFEIT`, `REFUND`.
- Auto-replenish top-ups appear as `PURCHASE` rows tagged `auto_replenish`; expirations as `EXPIRE` rows tagged `expiration`; engagement-close forfeitures as `FORFEIT` rows tagged `engagement_close`.

## Tips

- Auto-replenish only fires when both threshold and target are above zero and the balance has dropped below the threshold; the top-up cost is derived from the original opening rate per hour.
- If a rollover cap is set and the balance is already at or above it, auto-replenish skips that bank.
- The expiration worker writes a single `EXPIRE` transaction for the whole remaining balance, then marks the bank forfeited.
- Residual hours forfeit on engagement close — set clear forfeit language in the engagement letter so clients aren't surprised.
- Balance is always recomputed from the ledger, so transactions are append-only; there is no edit/delete.
