---
title: 'Integrations overview'
slug: integrations-overview
category: integrations
audience: staff
tags: ['integrations', 'providers', 'connect']
---

# Integrations overview

Vibe Practice Management connects to a handful of external services so the appliance can take card payments, send email and SMS, store files, reach the internet, and run cloud AI. The guiding rule everywhere: **you supply your own credentials**. Kisaes never holds your Stripe keys, mail-provider secrets, Cloudflare token, or AI keys — they live on your appliance (as env vars) or encrypted at rest in your own database.

## Steps

1. **Payments (Stripe).** Use your own Stripe account. You can enter the keys **in the UI** under **Admin → Billing → Stripe Connect** in the **Stripe API keys (firm-owned)** card — paste your **Secret key**, **Publishable key**, and **Webhook signing secret**, then **Save keys** (and **Test secret key** to confirm). Keys are encrypted at rest. (Operators may instead set `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` as appliance env vars.) Once a secret key is present, online card payment turns on and the staff **Receive Payment** form shows the Card (Stripe) option.
2. **Payments (CPACharge).** CPACharge is scaffolded but **not yet live** — the provider stub returns not-implemented and there's no admin screen to enable it today.
3. **Stripe Connect (optional).** A separate **Admin → Billing → Stripe Connect** page supports the operator-platform OAuth flow; it only appears configured when the operator has set the Connect env vars. The firm then clicks **Connect Stripe** to link its own account.
4. **Email provider.** Go to **Admin → Messaging → Email + SMS providers**. In the **Email provider** card, pick `SMTP`, `Postmark`, `Resend`, or `EmailIt`, fill the credentials, click **Send test**, then **Save**. (If a save fails, the error now names the exact field that's wrong — e.g. "host: Required".)
5. **SMS provider.** In the same screen's **SMS provider** card, pick `TextLink` or `Twilio`, enter credentials, **Send test** to an E.164 number, then **Save**.
6. **Object storage.** Configure your bucket under **Admin → Operations → Storage settings** / **Storage onboarding** (Backblaze B2 or MinIO/S3-compatible). See the storage articles.
7. **Cloudflare Tunnel.** Under **Admin → Operations → Cloudflare Tunnel**, paste an API token and provision hostnames. See _Remote access via Cloudflare Tunnel_.
8. **Cloud AI providers.** Cloud AI is set via env vars (`AI_CLOUD_API_KEY` for Anthropic, or the OpenAI-compatible vars); local AI uses Ollama. Cloud egress is additionally gated by the Vibe Shield policy.

## Fields

- **Stripe** — your account's **Secret key**, **Publishable key**, and **Webhook signing secret**, entered in **Admin → Billing → Stripe Connect** (or as appliance env vars).
- **Email** — **From address** plus provider secrets (SMTP host/port/user/password, Postmark **Server token**, Resend **API key**, or EmailIt **API key**).
- **SMS** — TextLink **API key**; or Twilio **From number (E.164)** + **Account SID** + **Auth token**.
- **Cloudflare — API token** — scoped for Tunnel + DNS edit.

## What you'll see

- The Email and SMS cards show a status pill: green "**<provider>** configured" when saved credentials exist, or neutral "Using env defaults" when none are saved (the dispatcher falls back to env vars).
- Saved messaging credentials are **encrypted at rest** and never returned in plaintext — reads show masked previews; editing requires re-entering the secret.
- **Clear** on a provider card removes the saved config and restores env-var defaults.

## Tips

- Use **Send test** before **Save** so you confirm connectivity without breaking live notifications.
- Rotating Stripe keys is a config change on the appliance — the publishable key is served at runtime, so no web rebuild is needed.
- Everything here is customer-owned: revoking a key at the provider immediately cuts the appliance's access.
- For programmatic access and outbound events, see _API access & webhooks_.
