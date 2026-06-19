---
title: 'Deployment modes'
slug: deployment-modes
category: deployment
audience: staff
tags: ['deployment', 'domain', 'lan', 'tailscale']
---

# Deployment modes & access

Vibe Practice Management runs as a self-hosted Docker appliance: an API container, a worker, Caddy as the ingress, and (in production) bundled Postgres, Redis, a nightly backup container, and a Cloudflare Tunnel sidecar. Caddy serves the staff app and client portal as static SPAs and reverse-proxies `/api/*` to the API on port `3001`. How you reach the two apps depends on which compose file and hostnames you use.

## Steps

1. Build and start the local appliance: `docker build -t vibe-time-billing:local .` then `docker compose -f ops/docker/docker-compose.local.yml up -d`. This starts `init-static` (copies the bundled web + portal dists into a shared volume), `api`, `worker`, and `caddy`.
2. Reach the apps over HTTPS on the published Caddy ports: staff at `https://<VIBE_HOST>:5195`, portal at `https://<VIBE_HOST>:5196`. The API is also exposed at `http://localhost:3001` for debugging.
3. For LAN access from other machines, set `VIBE_HOST=<lan-ip>` before `up`. Caddy binds its TLS sites to that host and uses it as `default_sni` so handshakes to a bare IP succeed.
4. Accept the one-time browser warning for Caddy's internal-CA cert (`tls internal`), or import Caddy's root CA. HTTPS is required because the session cookie is `Secure` — over plain HTTP off-localhost the browser drops it and login loops.
5. In production, deploy with `ops/docker/docker-compose.prod.yml` (image `ghcr.io/kisaesdevlab/vibe-time-billing:${TAG:-latest}`), which publishes Caddy on `80`/`443` and host-routes `app.<domain>` to staff and `portal.<domain>` to the portal.

## Fields

- `VIBE_HOST` — host the local Caddy TLS sites bind to; defaults to `localhost`. Set to your LAN IP for off-box HTTPS.
- `APP_BASE_URL` / `PORTAL_BASE_URL` — staff and portal base URLs used in links/emails (local defaults `http://localhost:5195` / `:5196`).
- `STAFF_JWT_SECRET` / `PORTAL_JWT_SECRET` — distinct signing secrets per realm; required.
- `KMS_KEY` — 32-byte base64 envelope-encryption master key; required (API exits at boot if missing).
- `COMMERCIAL_LICENSE_TOKEN` — enables the client portal; absent means portal disabled.

## What you'll see

- Staff requests get `X-Vibe-Realm: app`; portal requests get `X-Vibe-Realm: portal`. The API uses this plus distinct cookies to keep realms isolated.
- On local, both apps live on the same host but different ports (`5195`/`5196`) because one `localhost` can't disambiguate by Host header.
- In production both realms share `80`/`443` and split by hostname: `portal.*` matches the portal block, everything else (including direct IP) gets the staff realm.

## Tips

- The local compose joins the external `docker_default` network so DNS names `postgres` and `redis` resolve.
- Re-running `up` re-runs `init-static`, so a fresh image rebuild propagates to the static volume.
- The sealed firm key persists on a named volume — keep that volume to avoid re-bootstrapping the master key and orphaning encrypted data.
