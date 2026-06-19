---
title: 'Adjustments & per-timekeeper realization'
slug: adjustments-allocation
category: prebill-adjustments
audience: staff
tags: ['adjustments', 'write-down', 'write-up', 'realization', 'allocation']
---

# Adjustments & allocation

Open the dialog with **Create adjustment** on a DRAFT or IN_REVIEW batch ("Create adjustment — batch WIP $…"). It previews the per-timekeeper effect live.

## Steps

1. Set **Direction** — **Write-down** or **Write-up**.
2. Enter **Amount (USD)**.
3. Choose **Method** — Time / Fee / Rate.
4. Choose an **Allocation method** (below).
5. Pick a **Reason code** (filtered to write-down vs write-up codes) — **Create adjustment** stays disabled until one is chosen.
6. Optionally add **Notes**, review the **Per-timekeeper preview**, and click **Create adjustment**.

## The six allocation methods

- **Pro-rata by value** (default) — split across entries by each entry's dollar value.
- **Pro-rata by hours** — split by hours.
- **Partner absorbs** — distribute entirely across partner-role entries (fails if none).
- **Hierarchical cascade (junior held harmless)** — absorb from the top (partner → manager → senior → staff), sparing juniors until senior tiers are exhausted.
- **Specific entries** — caller-supplied per-entry amounts (must sum to the total).
- **Custom weighted** — per-timekeeper weights as percentages (sum to 100) or dollars (sum to the total).

## Per-timekeeper grain

Every allocation produces rows at the **(adjustment, time entry, timekeeper)** grain; realization rolls up from there. The preview shows Timekeeper · Role · Standard WIP · Adjustment · After · Realization %.

## Tips

- Pro-rata by value is the safe default. Partner absorbs requires a partner entry on the batch.
- All six methods are driven from the dialog: **Specific entries** lets you type a per-entry amount on each row, and **Custom weighted** lets you enter per-timekeeper weights (toggle between percent and dollars). The dialog validates that the parts sum to the total before you can submit.
