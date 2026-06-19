---
title: 'Creating and editing clients'
slug: creating-clients
category: clients
audience: staff
tags: ['clients', 'create', 'individual', 'business', 'wizard']
---

# Creating clients

## Steps

1. Open **Clients**. Click **+ New client** (top-right of the Clients card) to open the **New client** wizard.
2. **Client type** step — choose **Individual** ("Single filer, joint filer, etc. Filing status applies.") or **Business** ("C-corp, S-corp, LLC, partnership, sole prop, nonprofit."). This drives the next step's fields.
3. **Client info** step — fill the name (**Client name (e.g. Smith, John)** for individuals, **Business name** for businesses). Optionally tick **Use a different client-facing name**.
4. Choose **Client owner \*** (partner in charge) and **Office \*** (both required in the wizard).
5. Optionally set **External ID**, **AWS ID**, **Source**, **Pipeline stage** (Client / Other / Prospect), **Terms (days)** (default 30), and — for individuals — **Filing status**. Leave **Active** on (default).
6. Step through the optional **Contacts**, **Custom fields**, and **Tags** steps.
7. Finish with **Create and manage** (opens the new client) or **Create and close** (returns to the list).

## Fields

- **Client name / Business name** — required, max 200 chars. Blank shows "Name and Client owner are required."
- **Client owner** — required.
- **Office** — required in the wizard (server falls back to your default office if omitted).
- **Terms (days)** — 0–365, default 30. **Filing status** — individuals only.

## Editing later

Open the client and use **Edit** on the **Client info** card to change name, owner, office, type, filing status, pipeline, terms, invoice consolidation, the **Active** toggle, and mailing address.

## Tips

- Individual vs Business only changes the name label and whether Filing status appears — both store the same way.
- **Client names must be unique within the firm** (case-insensitive). Creating or renaming to a name already in use is refused — e.g. `A client named "Smith, John" already exists. Use a distinct name (you can set a separate client-facing name later).` Archiving a client frees its name for reuse.
- **External ID** and **AWS ID** are two optional identifiers the [[document-inbox]] matches incoming documents against — set whichever your tax-software exports stamp on filenames. Both are unique per firm when set.
