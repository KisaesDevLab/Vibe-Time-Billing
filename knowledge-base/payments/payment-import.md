---
title: 'Importing payroll-charge payments (CSV)'
slug: payment-import
category: payments
audience: staff
tags: ['payments', 'import', 'csv', 'payroll', 'prepayment']
---

# Importing payroll-charge payments (CSV)

The **Import** tab on **Payments** takes a CSV of charges (for example, a payroll service's monthly charges) and, per client, creates an invoice for the work and records the payment against it — or records a prepayment credit when there's nothing to bill. It's built for high-volume, repetitive billing where the amounts are already known.

## The CSV

Provide columns for a **client code**, **charge date**, and **amount**, plus optional **client name** and **description**. The client code is matched to a client's External ID (then AWS ID). Lines are de-duplicated on client + description + amount, so re-uploading the same file won't double-bill.

## Steps

1. Open **Payments → Import**, choose the CSV, and select the **engagement type** these charges bill against.
2. Click **Preview**. Each client group shows the plan the app intends:
   - **Bill & pay** — the client has unbilled work on a matching engagement: an invoice is created at the charge amount and the payment is recorded in full.
   - **Prepayment** — no matching unbilled work: the amount is recorded as an unapplied credit.
   - **Pick engagement / Unmatched** — the app needs you to choose the engagement or client.
   - Duplicate lines already imported are shown struck-through and skipped.
3. Resolve any rows that need a pick, and choose write-up / write-down reason codes if the charge amount differs from the work in progress.
4. Click **Import**. The app creates the invoices, adjustments, and payments (or prepayment credits) and reports the result per client.

## Tips

- Engagements in a finished/terminal workflow state are excluded from matching even if still active, so closed work isn't billed.
- If a needed adjustment would exceed your approval threshold, that client is reported as an error to handle from [[prebills-wip]].
- The created invoices and payments appear normally on each client afterward.
