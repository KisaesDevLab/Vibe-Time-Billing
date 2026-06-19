---
title: 'Receiving and recording payments'
slug: recording-payments
category: payments
audience: staff
tags: ['payments', 'ach', 'check', 'manual', 'receive', 'autopay']
---

# Receiving payments

The **Receive payment** page handles money received outside Vibe (checks, cash, manual ACH) and live card charges via Stripe.

## Steps

1. Open **Receive payment** (from the AR area).
2. Pick a mode: **Record payment** ("Received via check, cash, other"), **Charge new payment** ("Process a card via Stripe" — only when Stripe + card processing are enabled), or **In-person terminal** ("Tap or insert a card on a connected reader" — collects on a Stripe Terminal card reader).
3. Set **Payment date** and an optional **Reference no.** ("Check #, wire conf #, etc.").
4. **Record** mode: choose a **Payment method** (Check / Cash / ACH (manual) / Other, plus any custom methods). **Charge** and **In-person terminal** modes run a card.
5. In **Amount**, enter **Amount received ($)** and pick the **Payee** (paying client). Use the **Entities included** card ("One payer may cover invoices for multiple entities they own") to add linked clients' invoices.
6. In **Outstanding transactions**, check each invoice to pay and adjust the per-row amount (selecting an invoice auto-allocates the entered amount up to its open balance). The **Auto-allocate** button spreads the amount received across the invoices oldest-first.
7. Submit: **Record payment** (or **Record + New** to record this one and immediately start another for a different client), or **Charge $X** → enter card details → **Confirm charge**.

## What you'll see

An allocation summary ("Payment: $X allocated"). If you enter more than you allocate, "$X surplus → becomes a credit on submit" and an overpayment credit is created. A card charge cycles **Confirm charge → Confirming… → Awaiting Stripe…** and is finalized by the **Stripe webhook** (the source of truth) — if it's slow you'll see "Charge is still processing… check AR in a moment." After a payment is recorded you get a receipt with **Print receipt** and **Email receipt** buttons; for a multi-entity payment the receipt lists every entity under **Entities included**. When a payment fully pays an invoice, gated **pay-to-unlock** deliverables unlock and the portal contacts are emailed.

## Managing recorded payments

Receive payment is for _taking in_ money. To review, edit, re-apply (re-allocate), void, or pull a receipt for payments already recorded, use the separate **Payments** list (`/payments` in the left nav), which also hosts the **ACH returns** and CSV **Import** ([[payment-import]]) tabs.

## Tips

- **Record** = money already in hand; **Charge** runs a card via Stripe; **In-person terminal** collects on a card reader. If you close the page mid-charge, the webhook still completes it — check AR.
- **Record + New** is the fast path when posting a batch of checks: it saves the current payment and resets the form for the next client.
- **Autopay** is a client-portal feature: clients enroll a saved card per engagement (Portal → Payment methods → Autopay enrollment), and the recurring-billing run charges it when an invoice is created.
