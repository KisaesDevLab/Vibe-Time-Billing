---
title: 'Working the client list'
slug: working-the-client-list
category: clients
audience: staff
tags: ['clients', 'list', 'filter', 'bulk-email', 'recurrences', 'csv']
---

# Working the client list

The **Clients** page (`/clients`) is the firm's roster. This article covers finding clients and acting on them in bulk; for adding records see [[creating-clients]].

## Who can do this

Staff with client read access can browse and export. **Send email** and **Roll due recurrences** are firm actions and require the matching write/admin permissions.

## Steps

1. Open **Clients** from the left navigation.
2. Search with the box: **Search name, external ID, owner, office…**.
3. Filter from the column headers — **Owner**, **Type**, **Office**, and **Status** each carry a filter; **Name**, **Outstanding Bal.**, and others sort.
4. Sort by **Outstanding Bal.** to surface clients who owe the most.
5. Adjust visible columns from the column controls, and export the list with the CSV download.
6. Select clients and click **Send email** to open **Send email to selected clients** (fill **Subject** and **Body**, then **Send to {n}**).
7. Use the header **Roll due recurrences** to advance any recurring engagements that have come due.

## Field reference

- **Outstanding Bal.** — each client's open AR balance; sortable to rank debtors.
- A status cell may read **{STATUS} · view as ↗** (opens the portal as that client) and show a **Restricted** pill where access is limited.
- The bulk-email result reports **Done.** with **{sent} sent · {skipped} skipped.**

## Common errors

The bulk-email dialog needs a **Subject** and **Body** before **Send to {n}** is meaningful. Clients without a deliverable email are counted under **skipped** rather than failing the send.

Related: [[creating-clients]], [[bulk-import-clients]], [[client-detail]], [[recurring-engagements]], [[ar-aging]]
