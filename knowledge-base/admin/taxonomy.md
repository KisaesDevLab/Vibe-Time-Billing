---
title: 'Taxonomy: service lines, work codes, reason codes'
slug: taxonomy
category: admin
audience: staff
tags: ['taxonomy', 'service lines', 'work codes', 'reason codes']
---

# Taxonomy: offices, work codes, service lines, reason codes, templates

Taxonomy is the reference data that scopes and prices work. It lives in two admin groups: **Firm** (offices) and **Catalog** (everything else). Most taxonomy edits require `taxonomy:read`/`taxonomy:write`; offices use `office:read`/`office:write`.

## What you'll see

- **Taxonomy** page (`/admin/taxonomy`) stacks three cards: **Service lines**, **Work codes**, **Reason codes**.
- **Offices** (`/admin/offices`) under the Firm group.
- **Engagement statuses**, **Templates**, and **Recurring engagements** under the Catalog group.

## Fields

- **Service lines**: **Name** + a free-text **Category** (any label you like; defaults to the name). Rename via the row's **Rename** button.
- **Work codes**: **key** (snake_case) + **Display name**, with a **Billable default** column. Work codes drive in-scope tagging on engagements and can be attached to staff under a user's **Skill Set** tab.
- **Reason codes**: **Category** (Write-down, Write-up, Transfer) + **Label**. Used when staff record write-ups/write-downs and transfers.
- **Offices**: **Name** + **Timezone**; one office is flagged `default`. Each office has a **Settings** panel with per-office overrides.

## Steps

1. **Add a service line**: Admin → Catalog → Taxonomy → **Service lines** card → type **Name**, optionally type a **Category**, click **Add**.
2. **Add a work code**: in the **Work codes** card, enter **key (snake_case)** and **Display name** (and optionally assign a **Service line**), click **Add**.
3. **Add a reason code**: in the **Reason codes** card, pick **Category**, type **Label**, click **Add**.
4. **Add an office**: Admin → Firm → Offices → **Add office** card → **Name** + **Timezone** → **Add**.
5. **Override an office setting**: click **Settings** on an office row, then set any of **Adjustment approval threshold (cents)**, **Time entry rounding (hours)**, **Late-entry alert days**, **Late-entry lockout days**, **Invoice numbering prefix**. Leave blank to inherit the firm value; the "Effective" line shows the resolved value.

## Tips

- **Office overrides** are where per-office time-entry rounding lives — blank means "inherit firm default". Use **Clear** to drop an override.
- **Engagement statuses** (`/admin/engagement-statuses`) lets you relabel/recolor and set kanban visibility for each workflow state; the underlying state set is fixed.
- **Templates** (`/admin/templates`) holds engagement, letter, client, and request templates — carrying default fee, budget hours, work codes, and name patterns.
- Taxonomy rows are renamed in place, not deleted, to keep historical references intact.
