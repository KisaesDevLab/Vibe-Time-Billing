---
title: 'Enabling OpenSign e-signatures'
slug: opensign-setup
category: integrations
audience: staff
tags: ['opensign', 'e-sign', 'setup', 'integration', 'admin']
---

# Enabling OpenSign e-signatures

OpenSign is an **optional**, per-firm e-signature backend (native is the default). It runs as an isolated **AGPL** sidecar reached over HTTP — the appliance never bundles or links OpenSign source. This is an operator/admin task; the full reference is `ops/docs/opensign-runbook.md`.

Important: the **self-hosted** OpenSign API is its **Parse Server cloud-function** API (`/api/app/functions/…`, authed with the Parse app id + master key) — **not** the hosted SaaS REST API or `x-api-token` (those don't exist on self-host).

## Steps

1. **Stand up the OpenSign stack** (four services — server, client, MongoDB, Caddy) from `ops/docker/opensign/`:
   - `docker compose -f ops/docker/opensign/docker-compose.yml up -d`
   - The UI comes up at `https://localhost:4001` (self-signed cert). Note the `APP_ID` + `MASTER_KEY` from `ops/docker/opensign/.env.prod`.
2. **Create an OpenSign account** in that UI — this user becomes the document owner. (Create it through the UI; the API signup path is unreliable on the current build.)
3. **Mint the webhook key**: in OpenSign, go to **Settings → Webhook**, generate the 64-character **Webhook Security Key**, and register the webhook URL `https://<appliance>/api/webhooks/opensign` for the events `created / viewed / signed / completed / declined`.
4. **Set the appliance env** (read by both api and worker) and restart them:
   - `OPENSIGN_URL` — the OpenSign API base reachable from the appliance.
   - `OPENSIGN_APP_ID` (default `opensign`) and `OPENSIGN_MASTER_KEY` (from `.env.prod`).
   - `OPENSIGN_PUBLIC_URL` — used to build signer URLs.
   - `OPENSIGN_API_EMAIL` / `OPENSIGN_API_PASSWORD` — the account from step 2.
   - `OPENSIGN_WEBHOOK_SECRET` — the key from step 3.
5. **Flip the firm to OpenSign**: **Admin → Firm settings → E-sign provider → OpenSign**, Save.

## What you'll see

- Setting `OPENSIGN_URL` is what makes the **OpenSign** option selectable in firm settings; while it's unset the appliance stays native-only.
- The webhook endpoint `POST /api/webhooks/opensign` returns **503** until `OPENSIGN_WEBHOOK_SECRET` is configured (mounted but inert) — that's expected before setup.
- On completion the appliance fetches the signed PDF + certificate from OpenSign and stores them in the firm's object storage; OpenSign is never given storage credentials.

## Tips

- Keep the master key and the Webhook Security Key secret; rotate them together.
- OpenSign brings its own MongoDB + signing certificate and adds real resource cost — leave it off unless a firm needs it.
- Reach OpenSign either via its Caddy URL or, if co-located, by attaching api/worker to its docker network and using the in-network server address.
