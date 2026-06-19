---
title: 'In-office signing & QR sheets'
slug: in-office-signing
category: signatures
audience: staff
tags: ['signatures', 'in-office', 'qr', 'opensign']
---

# In-office signing & QR sheets

In-office signing has the signer complete a request **on-site**, on a tablet or their phone, by scanning a QR code. It is a **distinct path from "Send for signature"** — it does **not** email the client, and it's the way to handle an **individual 1040 (Form 8879)**, which can't be e-signed remotely.

## Why 1040s use this path

Remotely e-signing an individual 1040 e-file authorization requires the IRS's Knowledge-Based Authentication (identity quiz), which this app doesn't offer — so **"Send for signature" is not available for a 1040**. Signing **in person** is the IRS-sanctioned alternative: the preparer verifies the taxpayer's government photo ID in person (Pub 1345), which replaces KBA. Business e-file authorizations (8879-S/C/PE) aren't KBA-gated and can be sent either way.

You can drive in-office signing in two places: from the **Signatures** detail page, or **inline on the tax return** — a return assembled with **Collect signatures** shows its request right on the return's Signatures card with the in-office controls there, so for a 1040 you never leave the return.

## How it works

1. Build the request (or assemble one from a return — see [[collect-signatures-from-return]]) and place the fields. You do **not** send it to the client.
2. While the request is still a draft, the in-office panel shows **View / Print QR sheet** (opens the QR sheet PDF) and **Set up on this device**. Click **Set up on this device** to begin. For a 1040, this is the primary action — the screen explains that no email is sent.
3. For a 1040 (Form 8879), record each signer's **government photo-ID type** and check **"I verified this person's photo ID in person."** This is required to satisfy the in-person IRS rule and is saved as an audit event (no ID numbers are stored).
4. Confirm to take the request live with **no email to the client**. The live in-office panel now shows **Print QR sheet** and **Refresh status**, plus per-signer **Sign now** and **Show QR** controls.
5. **Print QR sheet** for a one-page-per-signer PDF (each shows the signer's name and a QR to their signing page), or hand a signer the device with **Sign now**, or **Show QR** on screen.
6. The signer scans/opens their page and signs on the spot. Click **Refresh status** to pull the result immediately; once everyone has signed, the signed PDF is available to download (and a return-linked request files it to the client's Tax Returns folder automatically).

## Tips

- Each QR encodes that signer's private signing link — treat printed sheets accordingly.
- In-office signing still uses your firm's OpenSign connection to capture the e-signature; see [[esign-providers]] and [[opensign-setup]]. The difference is that nobody is emailed and identity is verified in person rather than by KBA.
- Track completion across requests in the [[signed-forms-report]].
