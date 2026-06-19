---
title: 'Remote access with Cloudflare Tunnel'
slug: remote-access-cloudflare
category: deployment
audience: staff
tags: ['cloudflare', 'tunnel', 'remote', 'dns', 'https']
---

# Remote access via Cloudflare Tunnel

For public access without opening firewall ports, the appliance ships a bundled `cloudflared` sidecar and an in-admin wizard that provisions a Cloudflare Tunnel for you. You paste a Cloudflare API token, the appliance creates the tunnel, writes DNS CNAMEs, sets ingress, and drops a run-token for the sidecar to consume. The sidecar dials out to Cloudflare's edge — no inbound rules required. You keep ownership of the Cloudflare account; the token is stored encrypted with the firm key. The wizard lives at **Admin → Operations → Cloudflare Tunnel** and gates on `firm:settings:write`.

## Steps

1. Create a Cloudflare API token with `Account:Cloudflare Tunnel:Edit` and `Zone:DNS:Edit` permissions.
2. Go to **Admin → Operations → Cloudflare Tunnel**. Under **Step 1**, paste the token into **API token** and click **Connect**. This validates the token and loads your accounts and zones.
3. Under **Step 2**, choose the **Account** and **Domain** from the dropdowns.
4. Under **Step 3**, add the hostnames to publish. Each row is a subdomain label plus a realm selector (**Staff** or **Portal**). Defaults are `app` → Staff and `portal` → Portal. Use **+ Add hostname** to add more.
5. Click **Provision tunnel**. The appliance creates the tunnel, sets ingress, writes CNAMEs to `<tunnel-id>.cfargotunnel.com`, encrypts both tokens, and writes the run-token to the sidecar volume.
6. To change hostnames later, click **Edit hostnames**, adjust the rows, and **Save changes** — this reconciles DNS and ingress in place without recreating the tunnel (the sidecar keeps running).

## Fields

- **API token** — entered as a password field; only the last 4 chars are retained as a hint.
- **Account** / **Domain** — chosen from discovered dropdowns.
- **Hostnames** — list of subdomain + realm. Staff hostnames route to the staff app; Portal hostnames to the client portal.

## What you'll see

- A status pill: `INACTIVE`, `PROVISIONING`, `ACTIVE`, or `ERROR`.
- When the sidecar is connected, a "N connector(s)" pill; when it isn't, a "sidecar offline" pill. A worker polls the sidecar's metrics endpoint once per minute and stores a snapshot, including edge region.
- Each hostname is listed with a Staff/Portal pill and its `https://<hostname>` URL.
- On failure the row goes to `ERROR` and a **Last error** box shows the Cloudflare message; the wizard re-opens as **Re-provision**.

## Tips

- Portal hostnames are saved but get no ingress/DNS until a commercial license token is active — re-provision picks them up once licensed.
- The tunnel ingress rewrites the origin Host header to `app.<zone>` / `portal.<zone>` so Caddy routes correctly regardless of the public label — no Caddyfile edits.
- **Disable** deletes the tunnel and its DNS records, clears the stored tokens, removes the token file, and sets status `INACTIVE` — traffic stops until you re-provision.
- On the local compose, the sidecar reads `TUNNEL_TOKEN` and only runs once a token file exists.
