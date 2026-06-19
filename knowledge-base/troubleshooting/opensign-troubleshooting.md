---
title: "OpenSign signing isn't completing"
slug: opensign-troubleshooting
category: troubleshooting
audience: staff
tags: ['troubleshooting', 'opensign', 'e-sign', 'webhook']
---

# OpenSign signing isn't completing

OpenSign signing is asynchronous, so most issues are configuration or webhook delivery — not the signature itself.

## Symptoms

- The **OpenSign** option is greyed out / not selectable in firm settings.
- The webhook endpoint returns 503 or 401.
- The client signed in OpenSign but the proposal never advances.

## Causes & fixes

1. **OpenSign option not selectable.** `OPENSIGN_URL` is unset, so the appliance is native-only (dormant). Fix: set the `OPENSIGN_*` env on **both** api and worker and restart (see _Enabling OpenSign e-signatures_).
2. **Webhook returns 503 `not configured`.** `OPENSIGN_WEBHOOK_SECRET` isn't set on the appliance — the route is mounted but can't verify deliveries. Fix: mint the Webhook Security Key in OpenSign and set the env, then restart.
3. **Webhook returns 401.** The HMAC didn't match — the appliance's `OPENSIGN_WEBHOOK_SECRET` differs from the key registered in OpenSign. Fix: re-copy the exact 64-char key into the env on both sides.
4. **Client signed but nothing happened.** The webhook may have been blocked (network/firewall between OpenSign and the appliance). The worker **poll** reconciles stuck OpenSign signatures every ~2 minutes, so it usually self-heals. If not, confirm `OPENSIGN_URL` is reachable from the api/worker containers and that the document's webhook events are registered.
5. **Signature recorded but no certificate/PDF.** The appliance fetches the signed PDF + certificate from OpenSign and stores them in the firm's object storage. Fix: confirm object storage is configured/healthy and that `OPENSIGN_API_EMAIL`/`PASSWORD` are valid (the fetch uses an OpenSign session).
6. **Can't create the OpenSign account via API.** Use the OpenSign **UI** to create the document-owner account — the API signup path is unreliable on the current build.

## Tips

- "Dormant" (no `OPENSIGN_URL`) and "misconfigured" (503/401) are different states — check whether the option is even selectable before chasing webhooks.
- Native e-sign keeps working throughout; you can always switch a firm back to **Native** in firm settings if OpenSign is down.
- Full setup + the verified cloud-function contract live in `ops/docs/opensign-runbook.md`.
