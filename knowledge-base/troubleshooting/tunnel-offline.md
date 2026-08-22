---
title: 'Cloudflare tunnel shows offline'
slug: tunnel-offline
category: troubleshooting
audience: staff
tags: ['troubleshooting', 'cloudflare', 'tunnel', 'offline']
---

# Cloudflare tunnel shows offline or provision failed

The Cloudflare Tunnel exposes the appliance on your own domain (`app.<zone>`, `portal.<zone>`) without opening inbound ports. Two distinct problems look similar in the admin UI: the tunnel was never provisioned successfully (`provision_failed`), or it was provisioned but the connector isn't currently running ("offline").

## Symptoms

- Tunnel status reads `INACTIVE`, `ERROR`, or the UI shows "sidecar offline."
- Provisioning returns `provision_failed` (502) with a Cloudflare error message.
- The public hostname returns a Cloudflare error page or times out.
- The status snapshot shows `ready: false` / zero connectors.

## Causes & fixes

1. **Connector (cloudflared sidecar) isn't running ("offline").** A worker polls the sidecar's local metrics endpoint (`http://cloudflared:2000`, `/ready` + `/metrics`) about once a minute; if it's unreachable it records `ready: false`, which the UI renders as offline. Fix (operator): ensure the `cloudflared` service is up. It waits for the token file (`/run/cloudflared/token`) and only starts once provisioning has written it — if the tunnel was never provisioned, there's no token and the sidecar idles by design. Provision from the admin UI, then confirm the container starts.
2. **Caddy isn't serving the tunnel origin on `:80`.** The tunnel ingress forwards to `http://caddy:80` and rewrites the Host header to `app.<zone>` / `portal.<zone>` (TLS is terminated at Cloudflare's edge, so plain HTTP here is fine). If Caddy isn't listening on `:80`, the tunnel is "up" but origin requests fail. Fix (operator): confirm Caddy handles `:80` (the local Caddyfile's `:80` block; prod maps `80:80`).
3. **`provision_failed` — orphan tunnel of the same name.** A prior failed provision can leave a Cloudflare tunnel whose id never reached the DB, so a fresh create fails ("tunnel with this name already exists", code 1013). Provisioning tries to delete the orphan first, but a permissions gap can block cleanup. Fix: ensure the API token can list/delete tunnels, then re-provision; the status row is stamped `ERROR` with the Cloudflare message.
4. **`provision_failed` — bad token, account, or zone.** Any Cloudflare API rejection surfaces as `provision_failed` with the underlying message. Fix: verify the API token scopes (account tunnels + zone DNS edit), the account id, and the zone id; read the **Last error** box for the exact message.

## Tips

- Each ingress rule uses `connectTimeout: 30` (seconds) and `noTLSVerify: true` against the in-network Caddy origin — these are expected, not errors.
- "Offline" (connector down) and "provision failed" (Cloudflare API rejected setup) are different problems — check the metrics snapshot for the former and **Last error** for the latter.
- After fixing credentials or DNS, re-provision from the admin UI; editing hostnames via **Save changes** updates in place without disturbing the connector.
- The sidecar reads only the token file, so it does not need restarting when hostnames change.
