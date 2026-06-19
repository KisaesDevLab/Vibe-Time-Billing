---
title: 'Services catalog & packages'
slug: services-packages
category: proposals
audience: staff
tags: ['services', 'packages', 'catalog', 'pricing']
---

# Services catalog & packages

Before you can build a proposal, your firm defines the _services_ it sells and (optionally) bundles them into _packages_. Both feed directly into the proposal editor's "Services list" and "Package selector" blocks. This article covers defining services with tags, building packages, and who can manage them.

## Steps

1. Open the services catalog at `/admin/services` (Admin sidebar → **Services catalog**). The header reads "Services catalog — Define the services your firm bills for. Used by proposals + engagements."
2. (Optional) Set up tags first. In the **Tags** card, type a name into the `Tag name` field, pick a color, and click **Add tag**. Hover a tag to **rename** or **×** (delete) it.
3. Click **New service** to open the editor card.
4. Fill in **Name**, **Category**, **Billing type**, **Default price (USD)**, and optionally **COA code** and **Add-on of (parent)**.
5. If billing type is `recurring` or `split deposit recurring`, a **Recurring interval** field appears — pick one.
6. Add a **Description (Markdown)** and toggle any **Tags** at the bottom of the editor.
7. Click **Create service** (or **Save changes** when editing).
8. To raise/cut prices in bulk, check several services, click **Bulk price… (N)**, choose **Percent delta** or **Flat delta**, enter a value, and click **Apply**.
9. To build a bundle, open `/admin/packages` (Admin → **Packages**). Use the **Add tier** form, then select a tier card to attach services, set override prices, and toggle `included`.

## Fields

- **Category** — one of `TAX`, `BOOKKEEPING`, `AUDIT`, `ADVISORY`, `PAYROLL`, `CFO`.
- **Billing type** — `ONE_TIME`, `RECURRING`, `ON_COMPLETION`, or `SPLIT_DEPOSIT_RECURRING`.
- **Recurring interval** — `MONTHLY`, `QUARTERLY`, `SEMIANNUALLY`, or `ANNUALLY` (required only for recurring billing types).
- **Default price (USD)** — entered in dollars, stored as cents.
- **COA code** — optional chart-of-accounts code.
- **Add-on of (parent)** — links this service as an add-on under a parent service.

## What you'll see

- The services grid shows Name, Category, Billing, Default price, Tags, and a Status pill (`Active` or `Archived`).
- Archiving a service is a **soft delete** — it hides from the default list but stays in the database so existing proposals and engagements still reference it. Check **Include archived** to see archived rows, then **Restore** them.
- Packages display grouped by name; each tier shows its included total and an included-service count.

## Tips

- Tags only group services for filtering and selection — deleting a tag just untags its services, it does not delete them.
- There is no hard delete in v1; every service is archived rather than removed to keep proposal/engagement history clean.
- Bulk price is floored at $0 — values can't go negative. Percent is entered as a number (e.g. `5` = +5%, `-5` = -5%).
- Editing services and packages requires `service:write`; viewing requires `service:read`. Every change is audit-logged.
- Use **Duplicate** on a package tier to clone its services into a new tier quickly.
