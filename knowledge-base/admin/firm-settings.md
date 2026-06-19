---
title: 'Firm settings'
slug: firm-settings
category: admin
audience: staff
tags: ['admin', 'firm', 'settings', 'offices']
---

# Firm settings

The **Firm** group of the admin area holds the firm-wide defaults that drive billing, approvals, branding, security, and AI. Open **Admin → Firm → Settings** (`/admin/firm`). The page is one long form split into cards; one **Save** button commits the whole form. Reading requires `firm:settings:read` (partner and above); saving requires `firm:settings:write`, which only the **admin** role template carries by default.

## What you'll see

- A stack of cards, top to bottom: **Firm**, **Engagement defaults**, **Approvals + auth + AI**, **Time entry**, **Portal**, **E-signature**, **Branding**, **Document intake — CAPTCHA**, **Billing and A/R**, and **Security · Unlock mode**.
- A **Save** button with a "Saved at …" confirmation timestamp.

## Fields

- **Firm**: **Default allocation method**, **Fiscal year starts in** (month), **Default invoice terms (days)**.
- **Engagement defaults**: **Enabled fee structures** (toggle pills — you cannot drop to zero), **Firm-wide billable target (hrs/month)**, **Default invoice surcharge label**.
- **Approvals + auth + AI**: **Adjustment approval threshold ($)** (default $1,000), **AI monthly budget ($)**, **AI provider preference** (Default local-first / Force local (Ollama) / Force cloud (Anthropic)), **Step-up TOTP timeout (minutes)** (default 30), and a **Require a second factor for staff sign-in\*\* toggle (leave on for any internet-reachable appliance — see [[two-factor]]).
- **Time entry**: **Late-entry alert (days)**, **Late-entry lockout (days)**, **Invoice numbering prefix**.
- **Portal**: **Portal enabled** checkbox, **Portal subdomain**.
- **E-signature**: the firm's **proposal e-signature provider** (e.g. Native or OpenSign) — see [[esign-providers]].
- **Branding**: **Invoice template style**, **Display name**, a **Logo (wide)** upload and **Logo URL**, an **App icon (square)** upload, **Accent color (hex)**, **Support email**, **Support phone**, **Support fax**, **Website**, **Footer HTML**.
- **Document intake — CAPTCHA**: a **Cloudflare Turnstile** site key + secret, used to protect the public intake / booking pages.
- **Billing and A/R**: default invoice/statement formats for new clients, days-until-due, the **Time entry rounding (hours, firm-wide)** selector (**0.25 — quarter hour (default)**, **0.10 — six minutes**, or **0.00 — No rounding (free decimal)**), ACH/credit-card processing toggles, statement e-mail message, service-charge rate, dunning messages **1 Period old** through **5 Periods or older**, and **A/R Terms** (printed at the bottom of every invoice PDF).

## Steps

1. Go to **Admin → Firm → Settings**.
2. Adjust the relevant card(s).
3. Set the **Adjustment approval threshold ($)** and **AI monthly budget ($)** as dollar amounts.
4. Enter dunning text per aging bucket and your **A/R Terms** block.
5. Click **Save** and confirm the "Saved at …" timestamp.

## Tips

- Branding feeds invoice PDFs, the client portal header, and dunning emails.
- The **Security · Unlock mode** card lets an admin switch from "Sealed on disk" to "Admin passphrase" — this is one-way and irreversible; losing the passphrase makes encrypted data unrecoverable.
- The AI monthly budget warns at 80% and hard-caps at 100% of the amount you set.
