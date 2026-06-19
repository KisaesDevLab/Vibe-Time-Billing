---
title: 'Signature page detection rules'
slug: signature-page-rules
category: signatures
audience: staff
tags: ['signatures', '8879', 'page-rules', 'bookmark', 'detection', 'admin']
---

# Signature page detection rules

When you build a signature package from a tax-return PDF, the app finds the signature pages (e.g. the 8879) by matching the PDF's bookmarks. **Admin → Signatures → page rules** is where those rules live: each rule maps a PDF bookmark to a signature-field layout, scoped to a return type. Sensible defaults are seeded automatically, so most firms only adjust these when a new form or an unusual PDF layout shows up.

## Who can do this

Staff with **`firm:settings:write`** can add, edit, toggle, and delete rules; otherwise the page is read-only. Rules are grouped on screen by form type.

## Steps

1. Open the **Signature page rules** admin page.
2. To add a rule: pick the **Form type** (or **Custom…** to type one), enter a **Bookmark pattern**, choose a **Match** mode, pick the **Layout or profile** the fields come from, optionally check **Case-sensitive** / **Enabled** and add **Notes**, then click **Add rule**.
3. Edit an existing rule inline: change its **Fields from** layout in the dropdown, toggle **Enabled**, click **Edit** to change the bookmark pattern, or **Delete** to remove it.

## Field reference

- **Form type** — the return type the rule applies to (1040, 1120-S, 1065, … or **Any**).
- **bookmarkPattern** — the text matched against PDF bookmarks to locate the signature page.
- **matchMode** — **Contains**, **Exact**, or **Regex**; with **Case-sensitive** it appends "(cs)".
- **layoutKey** (shown as **Fields from**) — which signature-field layout to apply: **1040 8879 (taxpayer+spouse)**, **Entity 8879 (officer)**, **State auth (taxpayer+spouse)**, or **Generic**. You can also pick a saved **Profile: <form> (v#)** — the firm's latest placement profile for that form type, with the layout as fallback.
- **Enabled** — whether the rule participates in detection.
- **Notes** — free text for your own reference.

## Common errors

- **Signature pages not detected** — no enabled rule's bookmark pattern matched the PDF; check the bookmark text in the PDF and add/adjust a rule (try a looser **Contains** match).
- **Wrong signature fields placed** — the matched rule points at the wrong **Fields from** layout/profile; change it on the rule's row.
- **form_type_required** — you tried to add a rule with a blank custom form type.

Related: [[signatures]] [[signatures-overview]] [[tax-returns-overview]]
