---
title: 'Import clients from CSV or Excel'
slug: bulk-import-clients
category: clients
audience: staff
tags: ['clients', 'import', 'csv', 'xlsx', 'excel', 'ultratax', 'bulk', 'wizard']
---

# Import clients from CSV or Excel

The **Import clients from CSV / Excel** wizard bulk-creates (and optionally updates) client records from a spreadsheet — a `.csv` or an `.xlsx` workbook (first sheet). It is a two-step flow: **1 · Upload** then **2 · Preview**.

## Who can do this

Staff with client-write access.

## Steps

1. From the Clients area click **Import clients**.
2. On **1 · Upload**, either click **Download CSV template** (saves `client-import-template.csv`) to get the exact header row and fill it in, or use a tax-software export as-is (see _UltraTax_ below). Choose your file under **CSV or Excel file**.
3. Optionally set **Default client owner (for rows with no owner column)** and **Default office (for rows with no office column)**.
4. Tick **Update fields on existing clients** if rows that match a client you already have should also refresh its address, filing status, names and owner. Leave it off to only add missing people.
5. Click **Preview** (shows **Validating…** while it runs). This moves you to **2 · Preview**.
6. Review the summary — **Total rows**, **Will create**, **Will update**, **Will skip** — and the per-row table: **Row**, **Name**, **Action** (create / update / skip), **Owner** (the resolved staff member, or _(default)_), **People** (how many contacts the row carries), **Changes** (which fields an update will rewrite), **Reason / warnings**.
7. Click **Import {n} new (+ update {m})** (**Importing…** while it runs). On completion you'll see _"Imported {n} clients."_ plus updated / people-linked / skipped counts; click **Done**. Use **Back** to return to upload.

## UltraTax CS Data Mining export

An UltraTax **Data Mining** export (columns such as _Client ID_, _Client name_, _Client name (first last)_, _Contact address 1_, _Filing status_, _Federal entity type_, _1040, Tp first name_, _Contact, Tp email address_, _Contact, Mobile telephone number_, _1040, Sp first name_, _Contact, Sp email address_, _Preparer name_) can be uploaded without editing:

- **Client ID** becomes the client's ID (the **External ID** field); re-uploading a later export matches on it.
- **Client name** → client name; **Client name (first last)** → client-facing name; **Filing status** words (_Married filing joint_, _Head of household_…) → MFJ / HOH etc.; **Federal entity type** `I` → Individual.
- **Taxpayer** (Tp first + last name, email, daytime phone, mobile) becomes the **primary + billing** contact with the **Taxpayer** role; **Spouse** (Sp first + last name, email, phones) is linked with the **Spouse** role. A spouse who shares the taxpayer's email/phone still gets their own person record (the shared value is kept on the taxpayer only — shown as a warning). The same person on two returns (e.g. a spouse who also files Head of household) becomes **one** person linked to both clients.
- **Preparer name** becomes the client **owner** when it matches a staff member's name (middle initials and punctuation are ignored); otherwise the **Default client owner** is used and the row shows an _owner not matched → default_ warning.

## Field reference

- **Required column:** `name` (or UltraTax _Client name_) — every other column is optional. Columns are matched by header name; unknown columns are ignored.
- Client columns: `name`, `client_facing_name`, `client_owner_email` / `client_owner_name` (also `preparer_name`), `office`, `client_type`, `entity_type` (enum names or codes I/S/C/P/F/X), `external_id` (the client id — your own or UltraTax _Client ID_), `filing_status`, `pipeline_stage`, `terms_days`, `invoice_consolidation_preference`, `tags`, `mailing_street1`, `mailing_street2`, `mailing_city`, `mailing_state`, `mailing_postal`, `mailing_country`.
- People columns come in slots — `taxpayer_*`, `spouse_*`, `billing_contact_*`, `contact3_*` … — each with `_name` (or `_first_name` + `_last_name`), `_email`, `_phone`, `_mobile`, `_role`. Taxpayer is the primary contact; spouse/taxpayer get the Spouse/Taxpayer roles automatically.
- **Default client owner** falls back to **None**; **Default office** falls back to **Firm default office**.

## Matching, updates and errors

Rows that match an existing client — by `external_id` (Client ID), then name — are marked **update**: new people are linked to the client; with **Update fields on existing clients** ticked the **Changes** column lists the columns that will be rewritten (the owner is only changed when the row's owner/preparer matches a staff member). Rows with problems are marked **skip** with a **Reason** (missing name, unknown office, invalid filing status, duplicate id in the file…). The preview must be run before **Import** is meaningful (otherwise it prompts _"Run the preview first."_).

## Adding or linking a taxpayer or spouse by hand

On a client, open the **People** card → **Add contact**. Start typing a name or email: pick an existing person from the firm directory to **link** them (no duplicate record), or type a new name to create one. Choose the **Role** (Individual clients pre-select _Taxpayer_ for the first person and _Spouse_ for the next) and mark the taxpayer as **Primary** / **Billing** from the row's manage panel.

Related: [[working-the-client-list]], [[creating-clients]], [[client-detail]]
