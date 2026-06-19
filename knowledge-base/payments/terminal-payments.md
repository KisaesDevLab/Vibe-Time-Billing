---
title: 'In-person card payments (Stripe Terminal)'
slug: terminal-payments
category: payments
audience: staff
tags: ['payments', 'terminal', 'stripe', 'card-present', 'reader', 'in-person']
---

# In-person card payments (Stripe Terminal)

**Admin → Terminal** lets staff take a card payment in person — at the front desk or in a meeting — by sending an amount to a physical card reader and having the client tap or insert their card. Each payment is tied to a specific invoice. The default hardware is the Stripe Reader S700 (S710 where office internet is unreliable).

## Who can do this

Staff with the **`payment:read`** permission can view readers and locations; **`payment:write`** is required to register hardware and collect payments. Stripe Connect must be set up on your firm's connected account first — the page header notes "Requires Stripe Connect to be set up."

## Steps

First-time setup (once per office):

1. In **Add a location**, fill **Display name**, **Address line 1**, **City**, **State**, **ZIP**, and click **Add location**.
2. In **Register a reader**, enter a **Reader label**, the **Registration / pairing code** from the reader's settings screen, pick the **Location**, and click **Register reader**. The reader appears in the **Readers** table with a status (online/offline).

Taking a payment:

1. In **Collect a payment in person**, pick the **Reader**, paste the **Invoice ID** (invoice uuid), enter the **Amount ($)**, and click **Send to reader**.
2. You'll see "Sent to reader — ask the client to tap or insert their card." A panel appears showing the payment and reader status.
3. Once the tap/insert succeeds, click **Capture** to take the funds. Click **Cancel** to abort before capture.

## Field reference

- **Reader** — the physical reader the request is sent to; the dropdown shows label and live status.
- **Invoice ID** — the invoice the payment is applied to.
- **Amount ($)** — dollar amount; converted to cents when sent.
- **Capture / Cancel** — finalize or abort the in-flight payment. Capture only after the client has tapped/inserted and it succeeds.
- **Readers** table — Label, Device, Serial, Status, and a **Reset** action to clear a stuck reader (cancels its current action).
- **Registration / pairing code** — comes from the reader's own settings screen when you register it.

## Common errors

- **No readers registered yet** — register a reader (and a location first) before collecting; **Send to reader** is disabled with no readers.
- **Reader stuck on a prompt** — click **Reset** in the Readers table to cancel its current action, then re-send.
- **collect_failed / capture_failed** — usually a missing Stripe Connect setup or an invalid invoice/reader. Confirm Connect is configured and the IDs are correct.
- A card saved during an in-person payment charges as **card-not-present** on later recurring runs; in-person card-present rates apply only to the live tap.

Related: [[payment-setup]] [[recording-payments]] [[users-roles]]
