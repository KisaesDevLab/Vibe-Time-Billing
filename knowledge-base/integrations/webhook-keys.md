---
title: 'Inbound delivery-status webhook keys'
slug: webhook-keys
category: integrations
audience: staff
tags: ['webhooks', 'integrations', 'postmark', 'resend', 'twilio', 'textlink', 'delivery']
---

# Inbound delivery-status webhook keys

When you send email or text through Postmark, Resend, Twilio, or TextLink, those providers call back to tell us whether each message was delivered, bounced, or failed. **Admin → Webhook keys** sets the shared secret each provider must include so we can trust those callbacks.

These are **inbound** keys — secrets _they_ send _us_. They are not the same thing as the **outbound** webhooks your firm publishes to notify other systems of events here; those live under Integrations and have their own signing scheme.

## Who can do this

A firm administrator with access to Admin settings. The appliance must have **`KMS_KEY`** set, because the secrets are stored encrypted — without it the page shows "KMS_KEY is not set on the appliance — keys cannot be encrypted/saved" and the **Save keys** button stays disabled.

## Steps

1. Open **Admin → Webhook keys** (the "Inbound webhook signing keys" card).
2. For each provider you use — **Postmark (email)**, **Resend (email)**, **Twilio (SMS)**, or **TextLink (SMS)** — type the shared secret into its field. A provider already configured shows _(set)_ and a _•••••• (saved)_ placeholder.
3. Click **Save keys**. You'll see "Saved." on success.
4. In the provider's own dashboard, configure the delivery-status webhook to POST to the URL shown under each field — `/api/webhooks/notifications/<provider>` — and send the same secret in the **`X-Webhook-Token`** header.

## Field reference

- **Per-provider secret field** — the shared secret. Leave a field **blank to keep the saved value**; typing a new value replaces it. Values are stored encrypted and never shown back.
- **(set)** — shown next to a provider that already has a saved secret.
- These keys **override the appliance env vars** for the same providers.

## Common errors

- **KMS_KEY is not set** — the appliance can't encrypt secrets; set `KMS_KEY` and restart, then return here. **Save keys** is disabled until then.
- **Callbacks rejected / no delivery status** — the secret in the provider dashboard doesn't match what's saved here, or it isn't being sent in the `X-Webhook-Token` header. Re-save and re-check the provider config.
- **Wrong endpoint** — each provider has its own path; copy the exact URL shown under that provider's field.

Related: [[integrations-overview]] [[rest-api-webhooks]] [[email-not-arriving]]
