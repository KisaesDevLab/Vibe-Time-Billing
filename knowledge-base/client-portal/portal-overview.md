---
title: 'Client portal overview'
slug: portal-overview
category: client-portal
audience: staff
tags: ['portal', 'clients', 'license']
---

# Client portal overview

The client portal is a separate, branded web app (served from your firm's `portal.` subdomain) where your clients sign in to view and pay invoices, exchange messages and files, respond to requests, and review engagements, statements, and tax items. It runs as its own application — distinct from the staff app — with its own login and its own session.

## What you'll see

- The portal is **commercial-license-gated**. If the appliance has no commercial license token configured, the portal shows a full-page **Portal unavailable** message reading "This appliance does not have a commercial license token configured." Clients cannot even reach the login form.
- The portal can also be turned off per-firm. When a firm disables it, the same **Portal unavailable** page instead reads "Your firm has disabled the client portal." Both states point the client to "Contact your firm administrator for help."
- The portal header shows your firm's branding (logo + display name) when configured; otherwise it falls back to **Client Portal**. A green `portal` realm badge sits in the header.
- The left navigation a signed-in client sees is grouped: at the top **Overview**, **Messages**, and **Updates** (an in-app notices inbox that shows an unread count badge); then **Billing & payments** (**Invoices**, **Statement**, **Payment methods**, **Tax payments**); **Documents** (**Requests**, **Files**, **Letters**); **Your work** (**Engagements**, **Appointments**, **Tax returns**); and a footer (**Profile**, **Notifications**, **Activity**, **Help**, **Switch client**).
- On **Invoices**, clients see "Open invoices" and "Paid" cards, can open an invoice to see line items and payments, **View as PDF**, **Download receipt**, and pay an open balance with a `Pay $<amount>` button.
- On **Messages**, clients pick a thread and reply with a **Send** button.
- On **Requests**, clients see "Open requests" and "History," open a request to read it, post a reply, and mark it complete.
- On **Files**, clients browse folders and **Download** files.

## Tips

- The portal is intentionally scoped to one client account at a time (the session's active client). Clients with access to multiple entities use **Switch client** — see the alternate-contacts / multi-entity article.
- **Session isolation is absolute.** Staff and portal sessions never cross: they use distinct cookies, distinct paths, and distinct JWT signing keys. A staff sign-in is never valid in the portal and vice versa.
- The only way staff see the portal exactly as a client does is the **View as client** button on the client record (read-only, short-lived session). See "Inviting a client to the portal."
- Portal sign-in is passwordless: clients authenticate with an emailed magic link or an SMS one-time code. There is no separate password to manage.
