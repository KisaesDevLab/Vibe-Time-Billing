# Network topology

Vibe Time & Billing is a self-hosted appliance. There is no SaaS layer;
firms run the stack themselves. This doc covers the three supported
network shapes plus the Cloudflare Tunnel template (Q10 locked) and
LAN/Tailscale-only deployments.

## Locked decisions

- Two ingress hosts: `app.firm.com` (staff) and `portal.firm.com` (clients).
  See `ops/caddy/` for Caddyfile templates.
- TLS 1.3 only at Caddy.
- Sessions: distinct cookies, distinct JWT signing keys, distinct Redis
  prefixes. Staff and portal cannot cross-share auth.

## Topology 1 — public Internet (most common)

```
                   Cloudflare (DNS + WAF)
                          │
                          ▼
                   [Cloudflare Tunnel]
                          │
                          ▼
              ┌────────────────────────┐
              │  Caddy (TLS 1.3)        │
              │  app.firm.com  →  api   │
              │  portal.firm.com → portal │
              └─────────┬──────────────┘
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
          api      portal       worker
            └───────────┼───────────┘
                        ▼
                 Postgres + Redis
```

Cloudflare Tunnel keeps the appliance off the public IP space. Origin
config lives in `ops/cloudflared/`. Two services:
- `app.firm.com` → `http://caddy:80/app`
- `portal.firm.com` → `http://caddy:80/portal`

## Topology 2 — LAN-only (small firm, single office)

Useful when all staff work from the same physical network and there is no
need for a public portal. The client portal is disabled at boot by
omitting the commercial license token.

```
       Office LAN (192.168.0.0/24)
                  │
                  ▼
         Caddy (TLS via internal CA)
                  │
                  ▼
            api + worker
                  │
                  ▼
          Postgres + Redis
```

Staff add `app.firm.com` to /etc/hosts pointing at the LAN IP. TLS is
mandatory; if you don't have a real cert, the appliance includes a
self-signed setup via `ops/caddy/Caddyfile.local`.

## Topology 3 — Tailscale (small firm, distributed)

For firms with a few partners in different locations and no public
portal. Tailscale provides the encrypted overlay; everything else looks
like the LAN-only topology.

```
   tailnet (100.x.x.x)
            │
            ▼
   Caddy on tailnet-only IP
            │
            ▼
      api + worker
            │
            ▼
    Postgres + Redis
```

Use Tailscale Serve to publish `app.firm.com` to the tailnet:

```bash
tailscale serve https / http://localhost:80
```

## Hostname requirements

The two ingress hosts MUST resolve to the appliance. The portal can be
disabled (no commercial license token) but the staff host is required.
Caddy refuses to start without valid certs for whichever hosts are
enabled.

## Outbound network

The appliance makes outbound requests to:

- Stripe (per firm's BYO keys, optional)
- The configured mail provider (SMTP/Postmark/Resend/SES)
- The configured SMS provider (TextLink/Twilio/SNS)
- The configured AI provider (Anthropic API / Ollama / OpenAI-compatible)

All other outbound traffic is denied at the appliance boundary. Firms
running in air-gapped environments should use the local LLM detection
script (`scripts/install-detect-llm.sh`) and disable the cloud AI
provider in firm settings.

## Backup transport

Nightly `pg_dump` writes to `/backups` inside the appliance. The
recommended pattern is a host-side syncthing/rclone job that mirrors
`/backups` off-appliance every 6h. See `ops/docs/restore.md` for the
restore procedure.
