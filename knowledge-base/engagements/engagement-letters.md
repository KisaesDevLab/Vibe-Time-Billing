---
title: 'Engagement letters'
slug: engagement-letters
category: engagements
audience: staff
tags: ['engagement-letter', 'letters', 'templates', 'lifecycle']
---

# Engagement letters

An engagement letter is the document a client signs to confirm the scope and fee of one engagement. The feature has four surfaces: the firm-wide list, a generator on the engagement, the send/accept/void lifecycle, and the admin template catalog.

This is **not** a proposal. A _proposal_ is a sales document that, when accepted, auto-creates the engagement; an engagement letter is written for an engagement that already exists and never creates one. It is also distinct from _terms templates_ — the engagement letter is the deliverable a client signs.

## Who can do this

- Viewing letters and the list needs `engagement:read`.
- Generating, sending, and voiding letters needs `engagement:write`.
- Editing the template catalog is an admin task.

## Steps

**Generate a draft from the engagement**

1. Open the engagement and find the **Engagement letter** card.
2. Pick a **Template** from the dropdown. The preview substitutes `{{client.name}}`, `{{engagement.name}}`, and `{{engagement.fee}}` (plus tax year / fiscal-year-end where present) before you save.
3. Review the preview, then click **Save as draft**. The card confirms with the new version number (e.g. "Letter v1 created as DRAFT").

**Track and manage from the list**

1. Open **Engagement letters** (`/engagement-letters`).
2. Use the **Status filter** to narrow to All / DRAFT / SENT / ACCEPTED / REJECTED / VOIDED.
3. Each row shows the engagement, version, status, and the Sent / Accepted / Created dates.

**Lifecycle**

- A new letter starts **DRAFT**.
- **Send** it to the client. The client reviews and e-signs it in their portal, which moves it to **ACCEPTED** (or **REJECTED** if they decline).
- **Void** a letter that should no longer stand; superseding it means generating a new version, which bumps the version number.

## Field reference

- **Template** — an ACTIVE letter template from the admin catalog; only ACTIVE templates appear in the picker. System templates are marked "system".
- **Status filter** — DRAFT (not sent), SENT (awaiting the client), ACCEPTED (client e-signed), REJECTED (client declined), VOIDED (withdrawn).
- **Version (v)** — re-generating produces a new version so the history is preserved.

## Common errors

- **No templates in the dropdown** — the catalog has no ACTIVE letter template; an admin must add/activate one.
- **Looking for proposals here** — a proposal that creates an engagement lives under Proposals, not Engagement letters. See [[proposals-overview]].
- **Variables show literally (e.g. {{engagement.fee}})** — that field is empty on the engagement (no fee set yet); it renders as "TBD" or the raw token. Set the fee, then re-generate.

Related: [[creating-engagements]] [[proposals-overview]] [[signatures-workspace]] [[notification-templates]]
