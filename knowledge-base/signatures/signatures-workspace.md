---
title: 'The Signatures workspace'
slug: signatures-workspace
category: signatures
audience: staff
tags: ['signatures', 'esign', 'opensign', 'fields', 'profiles']
---

# The Signatures workspace

**Signatures** (`/signatures`) is the standalone workspace for firm-wide e-signature requests built on OpenSign: upload any PDF, drag signature fields onto it, and send it to one or more signers. Each request opens its own detail page (`/signatures/:id`) where you prepare and send it.

## Who can do this

Creating, editing, and sending requests needs `proposal:write` (the same permission that gates proposals). Without it you can still see the list; **+ New request** and the prepare/send actions are hidden.

## Steps

**Create a request**

1. Click **+ New request**. Enter a **Title**, pick a **Form type** (Generic document, Engagement letter, or a Form 8879 variant), and optionally a **Client** — picking one lets you check off signers from that client's people.
2. Add **Signers** (name, email, optional mobile and role); use **+ Add signer** for more. A signer checked off from the client's people list brings their mobile along automatically. Click **Create draft**, which opens the detail page.

**Prepare & send** (on the detail page, draft only)

1. Under **Prepare & send**, click **Upload PDF** to attach the source document.
2. Either **Apply a placement profile** — choose a saved profile (matched by signer role) and click **Apply profile** — or place fields by hand in the editor: pick the **Signer** and **Field** type, then click a page to drop a field; drag to move, the corner handle to resize, the × to remove. Field types are **Signature, Initials, Date, Text, Checkbox**. Click **Save fields**.
3. Optionally **Save as profile** to reuse the current placements later (every signer with a field must have a role first).
4. Pick **Deliver by** — **Email**, **Text**, or **Email + text** — then click **Send for signature**. Each signer gets their link and the request moves to _Sent_. Texting needs a mobile on the signer; anyone without one is named in a warning before you send, and a sequential (in-order) request keeps using the same channel for each later signer.

## Field reference

- **Form type** — labels the request; some forms route differently (see errors).
- **Field types** — Signature, Initials, Date, Text, Checkbox. Every signer needs at least one signature field.
- **Deliver by** — Email (default), Text, or Email + text. The text carries the same signing link; edit its wording in **Admin → Notification templates → Signature requested (SMS)**.
- **Status** — Draft, Sent, Partially signed, Completed, Declined, Expired, Voided.
- **Signed (x/y)** — how many of the request's signers have completed it.
- **Resend** — on a live request, each unsigned signer's row has an envelope and a speech-bubble icon that re-deliver that signer's existing link by email or text. Nothing is re-created, so a link the signer already has keeps working; the text icon is greyed out when there's no mobile on file.
- **Completion confirmation** — when the last signer finishes, the client's billing (or primary) contact gets a confirmation with the signed PDF attached. Over 10 MB it isn't attached and the email instead names who to contact for a copy; that sentence is the `{{ document.copy_note }}` variable in **Admin → Notification templates → Signature completed**.
- **Auto-filing** — when the request names a client, the signed PDF (and its audit certificate) are copied into that client's folder on completion: **Tax Returns** for a return-assembled package, **Signatures** for everything else. The request's event trail records where each landed, or why it couldn't be filed (most often the client's folder isn't bound yet).

## Common errors

- **A 1040 / Form 8879 won't send remotely** — Form 8879 for an individual **1040** can't be e-signed remotely (the IRS requires Knowledge-Based Authentication, which this app doesn't offer). Use the **In-office signing** card instead. See [[in-office-signing]].
- **"Save as profile" rejected** — every signer with a placed field needs a role (profiles are keyed by role), and you must have placed at least one field.
- **Send disabled** — you can't send until at least one field is placed (and a source PDF is uploaded).

Related: [[in-office-signing]] [[opensign-signing]] [[engagement-letters]] [[collect-signatures-from-return]]
