---
title: 'The Payments list — edit, re-apply, void, receipts'
slug: payments-list
category: payments
audience: staff
tags: ['payments', 'reapply', 'void', 'receipt', 'csv']
---

# The Payments list — edit, re-apply, void, receipts

The **Payments** tab (`/payments`) is the payment-grain list of money received — card, ACH, in-person, and manually recorded — defaulting to the current month. This is where you correct and reconcile existing payments. To take a _new_ payment, use **+ Record payment**, which opens the full Receive Payment screen; this page is for everything after.

## Who can do this

- The list and CSV export are available to staff with payments access.
- **Re-apply** and **Edit** appear only on rows you're allowed to change (manually-recorded payments); **Void** appears only where voiding is permitted. Processor-settled card/ACH payments can't be edited here — refunds happen on the invoice.

## Steps

**Find payments**

1. Set the **From** / **To** date range and optionally type a client or invoice # in **Search**, then click **Apply**. **Reset** restores the current month and clears filters.
2. The summary strip shows Payments, Gross received, Processing fees, Net, Refunds, and **In flight (ACH)**.

**Re-apply** (move/split a payment across invoices)

1. Click **Re-apply** on the row. A drawer lists the client's open invoices with an amount box each.
2. Enter amounts; the allocations must total the payment amount exactly (the drawer shows how far off you are).
3. Click **Re-apply**.

**Edit** a manually-recorded payment

1. Click **Edit**; adjust the **Amount ($)** and **Date**, then **Save changes**. (To change which invoices it covers, use Re-apply instead.)

**Void**

1. Click **Void**; optionally type a reason in the prompt and confirm. The row then shows the VOIDED pill.

**Receipt** and **CSV**

- Click **Receipt** to open a drawer listing every invoice the payment was applied to, with the total applied.
- **⤓ CSV** downloads the currently filtered rows; **Full report ↗** opens the receipt-grain Payments Received report.

## Field reference

- **In flight (ACH)** — count of payments still PENDING (an ACH debit that hasn't settled). Shown as "PROCESSING" in the Status column.
- **Channel** — derived delivery channel (card / ACH / in-person / manual).
- **Fee / Net** — processing fee withheld and what landed net.
- **Status** — SUCCEEDED, PROCESSING (PENDING), FAILED, REFUNDED, PARTIALLY_REFUNDED, or VOIDED.

## Common errors

- **Re-apply button disabled / allocations don't total** — the allocated amounts must equal the payment amount before Re-apply enables.
- **No Edit/Void on a card payment** — processor-settled payments aren't editable here; handle refunds on the invoice.

Related: [[recording-payments]] [[ach-returns]] [[credits-refunds]] [[payment-import]]
