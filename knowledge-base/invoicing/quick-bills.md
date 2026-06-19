---
title: 'Quick bills (ad-hoc invoices)'
slug: quick-bills
category: invoicing
audience: staff
tags: ['quick bill', 'invoice', 'ad-hoc']
---

# Quick bills

A quick bill is an ad-hoc invoice that isn't tied to a pre-bill or engagement — the "charge $250 right now" path. It has a simple lifecycle: **DRAFT → SENT → PAID**, with **VOID** reachable from any non-void state.

## What it needs

- A **client**, an optional **description**, and one or more **line items** (each with a name, optional description, quantity, and unit price). The total is quantity × unit price.

## Lifecycle

- Create it (starts **DRAFT**); edit its description or replace its lines while still **DRAFT**.
- **Send** it (must be DRAFT with a total greater than zero) → **SENT**.
- **Mark paid** (manual) from **SENT** → **PAID**.
- **Void** it with a reason from any non-void state.

## Permissions & notes

- Viewing needs `invoice:read`; creating/editing/sending/voiding needs `invoice:write`.
- Sending locks the line items — edits are rejected once it leaves DRAFT.

> Note: quick bills are currently driven through the API (`/api/staff/quick-bills`); a dedicated screen may not appear in every build.
