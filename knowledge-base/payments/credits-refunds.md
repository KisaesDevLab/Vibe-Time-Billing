---
title: 'Credits and refunds'
slug: credits-refunds
category: payments
audience: staff
tags: ['credits', 'refunds', 'overpayment']
---

# Credits & refunds

A **credit memo** is money on file not yet applied to an invoice. Credits arise three ways: **manual**, **overpayment** (auto on Receive payment), and **refund excess**.

## Issue a credit (manual)

1. Open the client's **Billing** view → **Credits** card → **+ New credit**.
2. Fill **Issued** (date), **Amount ($)**, optional **Reference** and **Notes**, then **Add credit** (appears as source "manual", status **OPEN**).

## Apply a credit

On **Receive payment**, pick the payer so their open credits load, select the target invoice(s), then in **Open credits** choose the credit and **Apply to invoice** with an amount. To use only credits (no new money), leave **Amount received ($)** at 0 — the button reads **Apply $X from credits**. Credits can apply across entities within the same firm.

## Void a credit (step-up)

Voiding a memo prompts for a **Reason** and may re-prompt for your second-factor **step-up**; it cascades to active applications (sibling payments flip to refunded, invoice paid amounts drop).

## Refunds

A refund is processed against an invoice's most recent succeeded payment (step-up gated; needs `invoice:write`). It can be full or partial with an optional reason, calls the provider's refund (e.g. Stripe), marks the payment **REFUNDED**/**PARTIALLY_REFUNDED**, and reduces the invoice's paid amount. Excess beyond what the invoice needed becomes a **refund-excess** credit. A refunded pay-to-unlock deliverable reverts to hidden.

## Tips

- Credit statuses: OPEN → PARTIALLY_APPLIED → FULLY_APPLIED, or VOIDED — recomputed automatically.
- Refunds are currently driven via the API (`/api/staff/invoices/:id/refund`) in this build.
