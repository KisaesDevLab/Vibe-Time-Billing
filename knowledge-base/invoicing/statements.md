---
title: 'Statements of account'
slug: statements
category: invoicing
audience: staff
tags: ['statements', 'account', 'balance', 'aging']
---

# Statements of account

A statement summarizes a client's **SENT / PARTIALLY_PAID / OVERDUE** invoices (voided excluded) with a running balance and an aging breakdown.

## What it contains

- Each outstanding invoice as a debit row, with any successful payment shown right after as a credit, both carrying a running balance.
- Aging buckets: 0–30, 31–60, 61–90, 91–120, 121+ days past due, plus total due.
- A policy notice that balances over 90 days past due may have work suspended.

## How to produce one

Statements are produced from the **AR** page (`/ar`, see [[ar-aging]]):

- **One client** — click the **Statement** button on that client's row to download their statement-of-account PDF.
- **Many clients** — tick the row checkboxes (or **Select all**), then use **Generate statements (PDF)** for one combined PDF (one statement per page) for printing, or **Email statements** to email each client their own statement PDF to their billing contact.
- Computed "as of" today; only invoices with a remaining balance are listed.

## Notes

- Requires the `report:ar:read` permission; bulk email needs mail configured.
- Bulk actions skip clients with no outstanding balance, and email is skipped for any client without a billing-contact email.
