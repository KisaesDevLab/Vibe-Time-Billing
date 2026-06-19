---
title: 'Import clients from CSV'
slug: bulk-import-clients
category: clients
audience: staff
tags: ['clients', 'import', 'csv', 'bulk', 'wizard']
---

# Import clients from CSV

The **Import clients from CSV** wizard bulk-creates client records from a spreadsheet. It is a two-step flow: **1 · Upload** then **2 · Preview**.

## Who can do this

Staff with client-write access. The wizard creates new clients only — it never overwrites existing ones.

## Steps

1. From the Clients area open the import wizard (**Import clients from CSV**).
2. On **1 · Upload**, click **Download CSV template** (saves `client-import-template.csv`) to get the exact header row, fill it in, and choose your file under **CSV file**.
3. Optionally set **Default client owner (for rows with no owner column)** and **Default office (for rows with no office column)**.
4. Click **Preview** (shows **Validating…** while it runs). This moves you to **2 · Preview**.
5. Review the summary — **Total rows**, **Will create**, **Will skip** — and the per-row table (**Row**, **Name**, **Action** create/skip, **Reason**).
6. Click **Import {n} client(s)** (**Importing…** while it runs). On completion you'll see _"Imported {n} clients."_ plus any skipped count; click **Done**. Use **Back** to return to upload.

## Field reference

- **Required column:** `name` — every other column is optional. Columns are matched by header name; unknown columns are ignored.
- Recognized headers include: `name`, `client_owner_email`, `office`, `client_type`, `external_id`, `filing_status`, `pipeline_stage`, `terms_days`, `invoice_consolidation_preference`, `tags`, `mailing_street1`, `mailing_city`, `mailing_state`, `mailing_postal`, `billing_contact_name`, `billing_contact_email`, `billing_contact_phone`.
- **Default client owner** falls back to **None**; **Default office** falls back to **Firm default office**.

## Common errors

Rows that match an existing client — by `external_id`, or failing that by name — are marked **skip** with a **Reason** rather than creating a duplicate. The preview must be run before **Import** is meaningful (otherwise it prompts _"Run the preview first."_).

Related: [[working-the-client-list]], [[creating-clients]], [[client-detail]]
