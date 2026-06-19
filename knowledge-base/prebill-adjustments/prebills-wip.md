---
title: 'Pre-bills, billing batches & WIP'
slug: prebills-wip
category: prebill-adjustments
audience: staff
tags: ['prebill', 'wip', 'billing batch']
---

# Pre-bills, billing batches & WIP

A **billing batch** is the pre-bill. The staff app uses "billing batch" and "pre-bill" interchangeably; reach it under **Billing**.

## Steps

1. Open the **WIP** dashboard ("Firm-wide WIP") to see unbilled work, with filters for **Client**, **Engagement**, and **Client owner** and a "By engagement (largest first)" table.
2. Start a bill: click **Bill** on a single WIP row (pre-fills client, engagement, and period), or check several rows and click **Bill N selected** (prompts for **Period start**/**Period end**, one batch per engagement). Or use **Billing → Open a billing batch** directly.
3. Pick a **Client**, set **Period start**/**Period end**, choose a **Batch type** (**Standard** or **Retainer**).
4. Check one or more **Engagements** (Select all / Clear). Multiple = a consolidated bill ("one invoice covering N engagements. Surcharge and tax are skipped on consolidated bills"). Retainer batches are single-engagement.
5. Click **Create** to open the batch.
6. For each entry set the **Action**: **include**, **defer** (release to a future batch), or **write off**.
7. Optionally **Create adjustment** (see next article) or **Set target invoice amount** to auto-create the write-up/down for the delta; use **Invoice composition** for a memo + custom lines.
8. Click **Finalize** (status → **APPROVED**), then on an approved batch optionally tick **Offer retainer to client** and click **Generate invoice**.

## What you'll see

A status pill (**DRAFT / IN_REVIEW / APPROVED / INVOICED / CANCELLED**), summary figures (**Standard WIP (include)**, **Adjustments**, **Total to invoice**, **Defer**, **Write off**), a **WIP aging** panel (0-30 / 31-60 / 61-90 / 90+), an **AI pre-bill narrative** card (if AI is on), and an **Untracked client interactions** panel with **Convert** to log time from messages. The entries table carries a **Billed** column — the per-entry amount after adjustments — alongside the standard (WIP) value, with billed totals in the footer.

## After you finalize

Finalizing locks the entry actions (the **finalized lock**). From the invoiced batch you can **Print** or **Send** the invoice, or **Unfinalize** to void the current invoice and reopen a fresh draft batch for re-editing — unfinalize is refused once the invoice has a recorded payment. The invoice screen itself is view/print/send only; see [[creating-invoices]].

## Tips

- If an engagement's projected WIP exceeds its NTE cap, batch creation is rejected (`nte_cap_exceeded`).
- defer/write-off release the entry so a later pre-bill can pick it up — the time isn't lost.
