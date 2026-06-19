---
title: 'Tax payments tracking'
slug: tax-payments
category: tax-returns
audience: staff
tags: ['tax', 'payments', 'estimates', 'jurisdiction']
---

# Tax payments tracking

Tax payments let your firm record a client's tax obligations — by jurisdiction and payment type, with amount and due date — so they show up on the client's portal home with a "pay online" link where available. Staff record and maintain these; clients only view them. You can manage payments per client (Client detail → **Tax payments** card) or firm-wide (Tax page → **Payments** tab).

## Steps

1. Open a client and find the **Tax payments** card.
2. Click **+ Schedule tax payment** to open the inline composer.
3. Pick a **Jurisdiction** from the dropdown (only active jurisdictions appear).
4. Pick a **Payment type** — the list is filtered to the chosen jurisdiction. Types with a pay-online link show `(online)`.
5. Optionally set **Engagement (optional)**, **Tax year**, and **Internal notes (not shown to client)**.
6. Enter **Amount (USD)** (e.g. `2500.00`) and **Due date**.
7. Click **Schedule**. The payment is created with status `SCHEDULED`.
8. When the client pays, click **Mark paid** on the row, enter **Paid date** and an optional **Confirmation number**, then **Confirm**.
9. To cancel a scheduled payment, click **Void** and enter a reason. Only `SCHEDULED` payments can be voided; `PAID` payments cannot.

## Fields

- **Jurisdiction** / **Payment type** — stored as text so the row survives later catalog edits.
- **Payment URL** — the pay-online link, snapshotted from the catalog at create time so it stays stable; surfaced to the client as a link.
- **Amount (USD)** — entered in dollars, stored in cents.
- **Internal notes** — firm-internal only; never sent to the client.
- **Status** — `SCHEDULED`, `PAID`, or `VOIDED`.

## What you'll see

- The client card shows **Scheduled**, **Overdue**, and **Total scheduled** stats, plus a table with **Jurisdiction**, **Type**, **Amount**, **Due** (red when a scheduled item is past due), and **Status**.
- The firm-wide **Payments** tab (titled **Tax payments — firm-wide**) adds per-column filters (status, due-from/to, client, jurisdiction, payment type), sortable headers, and a checkbox column. Selecting rows enables **Send reminder**, which sends one message per client per channel (**Email** and/or **SMS**) summarizing the selected payments, with an optional note.
- In the portal, the client sees only `SCHEDULED` and `PAID` payments (and `PAID` only within the last 90 days); `VOIDED` rows and internal notes are hidden.

## Tips

- Viewing requires `tax_payment:read`; creating, editing, marking paid, voiding, and sending reminders all require `tax_payment:write`. Clients can never create or modify payments.
- A scheduled payment can only be edited while still `SCHEDULED`; once `PAID` it is terminal.
- If no jurisdictions are configured, the composer points you to **Admin → Catalog → Tax payments**.
- Reminders need email/SMS providers configured; clients with no active portal contact are reported as skipped.
