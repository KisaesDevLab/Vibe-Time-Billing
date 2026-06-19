---
title: 'Alternate contacts & multi-entity access'
slug: portal-alt-contacts
category: client-portal
audience: staff
tags: ['portal', 'contacts', 'multi-entity']
---

# Alternate contacts & multi-entity access

A portal identity is one person who can hold access to several client accounts at your firm, and who can verify more than one email or phone for sign-in and notifications. This article explains how that works and what the client manages themselves.

## Multi-entity access

- One identity, many entities: a single person can be invited to multiple clients. All their accesses live behind one sign-in. The portal sign-in screen states this directly: "One person, multiple entities — your accesses live behind a single sign-in."
- The active session is always scoped to one client at a time (the session's active client).
- The client switches entities on the **Switch client** page (**Switch active client** card), which lists each client they can access, their **role** there, and which one is currently **active**. Clicking **Switch** changes the active client and reloads.
- When a client has access to more than one entity, the **Switch client** page also shows a **Consolidated view** card with a "Show entries across all my clients" toggle. When on, the **Invoices**, **Tax payments**, **Engagements**, and **Activity** pages aggregate entries across every client they can access. It does not change which client is active for actions like making a payment.

## How staff add multi-entity access

- To give an existing portal user access to another entity, open that other client's record and invite the same person (same email or phone) via **+ Invite to portal** on the **People** card. Because the system dedupes by firm + contact, their existing identity gains a new access row immediately rather than creating a duplicate identity.

## Alternate contacts (client-managed)

Clients add and verify their own alternate emails/phones on the portal's alternate-contacts page (reached from **Profile**).

## Steps

1. The client opens the **Add an alternate contact** card.
2. They choose a **Channel** — **Email** or **SMS**.
3. They enter the value in the **Email address** or **Phone (E.164)** field.
4. They click **Send code**; the portal sends a verification code and shows "Verification code sent."
5. In the **Enter verification code** card they type the **6-digit code** and click **Verify**; on success they see "Contact verified."

## What you'll see

- The **Saved alternate contacts** table lists each contact with **Channel**, **Address**, and a **Status** pill (**verified** or **unverified**).
- Unverified rows offer an **Enter code** button; every row has a **Remove** button (with a "Remove this contact?" confirmation).

## Tips

- A contact can be re-added to reset its code; the system upserts on (identity, channel, value) rather than duplicating, and limits sends to roughly one per minute.
- Removing or adding alternate contacts is something the client does themselves; staff edit only the identity's primary name/email/phone from the client record's **People** card.
