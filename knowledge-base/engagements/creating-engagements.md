---
title: 'Creating engagements'
slug: creating-engagements
category: engagements
audience: staff
tags: ['engagements', 'create', 'scope', 'budget']
---

# Creating engagements

## Steps

1. From the **Engagements** list click **+ New engagement** (opens `/engagements/new`). (From a client's time-entry link the client is pre-selected.)
2. Pick the **Client** (required).
3. Optionally pick **Start from template** — it prefills fee structure, fee, budget hours, in-scope codes, rate code, and type, and shows a **Template applied** pill. Leave on "— blank —" for an empty form.
4. Enter the engagement **Name** (a template with a name pattern shows a "Will save as:" preview).
5. Set **Fee structure** and any fee fields; optionally **Period** (Year/Month/Label), **Default rate code**, **Type** (the read-only **Service line** is derived), **Start/End/Due date**, **Partner**/**Manager**.
6. Optionally add **Additional staff** (pick a person + role, click **Add**).
7. Toggle **Mixed-mode (in-scope per entry)**, **Fee passthrough**, **Charge sales tax**, **Add invoice surcharge**, or **Recurrence** as needed.
8. Click **Create engagement** (disabled until Client and Name are set).

## Fields

- **Client** — required. **Name** — required, 1–200 chars (unless a template name pattern resolves it).
- **Fee structure** — required (default Fixed fee); a firm can disable specific structures.
- **NTE cap ($)** — appears only for Hourly NTE. **Budget hours** — optional, steps 0.25.
- **Additional staff roles** — PARTNER, MANAGER, REVIEWER, PREPARER, STAFF (up to 50).
- **In-scope work codes** — shown only when Mixed-mode is on (click chips to toggle).

## What you'll see

On success you land on the engagement detail page. If you enabled Recurrence and that step fails, you'll see "Engagement created, but recurrence setup failed… Add the recurrence from the client's Engagements tab" and still land on the engagement.

## Tips

- Recurrence requires a template (the checkbox is disabled until one is picked).
- Fee passthrough adds a processing-fee line to this engagement's invoices.
