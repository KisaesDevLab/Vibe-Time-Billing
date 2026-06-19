---
title: 'AR aging by service line'
slug: ar-by-service-line
category: ar-collections
audience: staff
tags: ['ar', 'aging', 'service-line', 'receivables', 'reporting']
---

# AR aging by service line

This view (`/ar/by-service-line`) answers "which kinds of work are tying up our cash?" It pivots open receivables by **service line** across the standard aging buckets, so you can see, for example, that bookkeeping AR is current while a tax line is heavy in 90+.

## Who can do this

Staff with AR / receivables access. The view is read-only.

## Steps

1. Open **AR aging by service line** (`/ar/by-service-line`). The card title shows the **as-of** date the snapshot was computed.
2. Read the table: one row per service line, with a column for each aging bucket and a bold **Total**.
3. Compare buckets across rows to spot which service line is aging worst.

## Field reference

- **Service line** — the work category the receivable rolls up to.
- **0–30 / 31–60 / 61–90 / 90+** — open balance by days past due, in those buckets.
- **Total** — the row's total outstanding across all buckets.

## Common errors

- **"No outstanding AR by service line."** — nothing is currently open, or no open invoices map to a service line.
- **Numbers differ from the main AR aging** — this view groups by service line rather than by client; the firm total should still tie out. See [[ar-aging]].

Related: [[ar-aging]] [[dunning]] [[reporting-overview]]
