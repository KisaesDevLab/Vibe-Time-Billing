---
title: 'Creating and sending invoices'
slug: creating-invoices
category: invoicing
audience: staff
tags: ['invoice', 'billing', 'send']
---

# Creating & sending invoices

## Where you edit vs. where you view

The amounts, lines, and composition of an invoice are decided in **Billing** (the pre-bill), not on the invoice screen. The **invoice detail screen is view / print / send only** — the one thing you can change there is a line's **description text** (the amount stays locked). To change anything else, go back to the source pre-bill in Billing.

## Steps

1. **Generate from a pre-bill** — finalizing an **APPROVED** billing batch creates the invoice: it aggregates the included time net of adjustments, assigns a number (prefixed `INV`), sets the issue date to today and the due date from the client's terms.
2. Open **Invoices** (titled "Invoices — N"; columns Invoice · Client · Issued · Due · Total · Paid · Status · Viewed). Filter by status, client, owner, and **Issued from / to**.
3. Click **Open** (or **PDF**) on a row to view the invoice. **Edit in Billing** jumps back to the source pre-bill to change amounts, lines, or composition.
4. To fix wording, edit a **line's description** in place on the invoice (allowed while the invoice isn't voided and has no payments). The amount can't be changed here — adjust it from Billing.
5. **Send** from the list or the detail screen — it emails the client's billing contact and flips status to **Sent**. You can also **Print** the PDF. Composition (memo + custom lines), target amount, and write-ups/downs are all set in [[prebills-wip]].

## Render modes

The PDF supports a `mode` query value: `summary` (one aggregate line per kind), `by-line` (the line items — default), or `full-detail` (line items + a time-entry breakdown).

## Re-opening

On a **Sent**, unlocked invoice, **Re-open for editing** voids the current copy and creates a new **DRAFT** (number suffixed `-r###`) carrying manual lines forward; surcharge/tax recompute. An invoice with any recorded payment can't be re-opened/voided until the payment is reversed.

## What you'll see

The footer shows **Subtotal**, then **Surcharge**/**Sales tax**/**Processing fee** (only when non-zero), and **Total**. Surcharge/tax are auto-derived from the engagement's config and can't be edited directly. Consolidated invoices show one Time line per engagement and skip per-engagement surcharge/tax, following the client's consolidation preference.

## Tips

- To change surcharge/tax, edit the engagement's tax/surcharge config — the lines recompute on the next line-item change.
