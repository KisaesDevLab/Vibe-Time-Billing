---
title: 'Inviting a client to the portal'
slug: inviting-clients
category: client-portal
audience: staff
tags: ['portal', 'invite', 'access', 'magic link']
---

# Inviting a client to the portal

Staff grant portal access from the client's record, in the unified **People** card (it lists that client's contacts and portal logins together, and also has a **+ Add contact** action for adding a directory contact without a login). Each person you invite becomes a portal identity that can sign in on behalf of that client. This article covers sending an invitation, what the client does, identity verification, and managing access afterward.

## Steps

1. Open the client's record and find the **People** card.
2. Click **+ Invite to portal** (top-right of the card). The button toggles to **Cancel** while the form is open. (To add a contact with no login, use **+ Add contact** instead.)
3. Fill in the invite form: **Full name**, a **Role**, an **Email** and/or **Phone (E.164)**, and the **Send via** channel.
4. Click **Send invitation**. You'll see "Invitation email queued to …" / "Invitation text queued to …", or — if that contact already has a portal identity at your firm — "That contact already has a portal identity at this firm — access added immediately."
5. The client opens the invitation and accepts; their access flips to **ACTIVE** and they land on the portal home.

## Fields

- **Full name** — required free text (e.g. `Jane Doe`).
- **Role** — one of **Full access** (`FULL`), **View only** (`VIEW_ONLY`), or **Pay only** (`PAY_ONLY`). Defaults to **Full access**.
- **Email** — optional; standard email format.
- **Phone (E.164)** — optional; must be E.164 format (e.g. `+15555550123`).
- **Send via** — **Email** or **Text message**. Defaults to **Email**.
- Name plus at least one of email or phone is required; otherwise the form reports "Check the form — name plus either email or phone is required."

## What you'll see

- After sending, a new entry appears under **Pending invitations** showing the name, contact, role pill, an "Awaiting acceptance" pill, and an **Expires** date (invitations expire in 7 days).
- Each pending invitation has a **Resend** button. Resending issues a new link and invalidates the previous one ("the previous link is now invalid").
- Once accepted, the person moves into the access list with a role pill and a status pill (**ACTIVE**, **INVITED**, or **INACTIVE**), the contact summary, and a "last signed in" date when available.
- Expanding an access row shows: **Portal identity ID**, **Email verified**, **Phone verified**, **Invited**, **Accepted**, **Revoked** (if applicable), and **Identity status**.

## Identity verification

- Sign-in is passwordless. Email contacts get a magic link valid for 15 minutes; phone contacts get a 6-digit SMS code.
- **Phone re-verification happens on every new device** (fingerprinted by IP + user-agent); on a mismatch the portal sends an SMS one-time code to confirm the new device before issuing a session.
- The first SMS verification also captures TCPA SMS consent for the audit trail.

## Managing access

- **Change role / edit identity:** Expand a row, change the **Role** dropdown and/or edit **Full name**, **Email**, **Phone (E.164)**, then **Save changes**.
- **Revoke access:** Expand an active row and click **Revoke access**. The person is signed out and blocked from future sign-ins (status → **INACTIVE**). This is reversible.
- **Restore access:** Expand an inactive row and click **Restore access** to set it back to **ACTIVE**.
- **View as client:** On an **ACTIVE** row, click **View as client ↗** to open the portal in a new tab exactly as that person sees it — read-only, and the launch link is single-use and short-lived.

## Tips

- Granting portal access requires the `client:portal-access:manage` permission.
- Inviting a contact that already has an identity at your firm skips the email/SMS round-trip and grants access immediately (deduped by firm + email or firm + phone).
- Bulk invites are supported via CSV with the header `fullName,email,phone,role,deliveryChannel`.
- You can also manage everyone's access firm-wide from the [[people-directory]], and let clients ask for access themselves — see [[portal-access-requests]].
