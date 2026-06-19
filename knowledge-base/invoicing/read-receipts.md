---
title: 'Invoice read receipts'
slug: read-receipts
category: invoicing
audience: staff
tags: ['invoice', 'read receipt', 'viewed']
---

# Read receipts

Vibe records when a client **first opens an invoice in the client portal** — there is **no email tracking pixel**, so the receipt fires only on a genuine portal view.

## Where you see it

The **Viewed** column on the **Invoices** list: a green date once the client has opened it, or muted "not yet" before then. The first-viewed timestamp is set once (on the first portal load) and doesn't change on later views; each view also writes an audit-log entry (viewer identity, IP, user agent).

## Tips

- Opening or previewing the invoice email does **not** mark it viewed — only a portal view does.
- Sending by SMS is a nudge to the portal link; it doesn't mark the invoice viewed.
- If **Viewed** stays "not yet" long after sending, check the client can reach the portal and the email's link is valid.
