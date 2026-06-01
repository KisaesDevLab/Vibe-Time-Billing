# Install runbook

This runbook walks a CPA firm from "fresh VM" to "live Vibe Time &
Billing appliance" in about 30 minutes. The appliance is self-hosted
per Q1 — there is no SaaS layer.

## Prerequisites

- A host with 4 vCPU / 8 GB RAM minimum (16 GB recommended for the
  local LLM). Ubuntu 22.04 LTS or Debian 12 tested.
- Docker Engine 24+ and `docker compose` v2.
- A domain you control. You need DNS to point two hostnames at the
  appliance: `app.firm.com` and (optionally, with commercial license)
  `portal.firm.com`.
- An SMTP/email provider, or accounts at one of: Postmark, Resend,
  AWS SES. See `MAIL_PROVIDER` env vars in `.env.example`.

## 1. Pull the appliance image

```bash
docker pull ghcr.io/kisaesdevlab/vibe-time-billing:latest
```

## 2. Create the environment file

```bash
cp .env.example .env
```

Required:
- `DATABASE_URL` — `postgres://vibe:password@postgres:5432/vibe` if you
  use the bundled Postgres in `docker-compose.prod.yml`.
- `REDIS_URL` — `redis://redis:6379` if bundled.
- `STAFF_JWT_SIGNING_KEY` and `PORTAL_JWT_SIGNING_KEY` — generate with
  `openssl rand -hex 32`. **Distinct keys** per Q10.
- `MAIL_PROVIDER` + provider-specific keys.

Optional but recommended:
- `STRIPE_SECRET_KEY` (Q7 — firm-owned account)
- `ANTHROPIC_API_KEY` or local Ollama config (Q15)
- `COMMERCIAL_LICENSE_TOKEN` (Q6 — needed to enable the client portal)

## 3. Bring up the stack

```bash
docker compose -f ops/docker/docker-compose.prod.yml up -d
```

This starts: Postgres, Redis, API, worker, web (staff), portal,
Caddy ingress, and (optionally) a local Ollama instance.

## 4. Run initial migrations + seed

```bash
docker compose exec api node /app/scripts/migrate.js
docker compose exec api node /app/scripts/seed.js --firm "My Firm, CPA"
```

The seed creates the firm row, a default admin user, and the 5 system
role templates.

## 5. First-time login

1. Navigate to `https://app.firm.com/auth/login`
2. Enter the admin email from step 4. A magic-link email goes to that
   address.
3. Click the link → enroll TOTP (required per Q5). Save the recovery
   codes.
4. Land on the dashboard. Visit `/onboarding` for the setup checklist.

## 6. Configure Cloudflare Tunnel (recommended)

The appliance ships a bundled `cloudflared` sidecar (Q10). After the
stack is up, sign in as the admin and go to **Admin → Operations →
Cloudflare Tunnel** to provision the tunnel from the UI:

1. Generate an API token at https://dash.cloudflare.com/profile/api-tokens
   with permissions `Account → Cloudflare Tunnel:Edit` and
   `Zone → DNS:Edit` scoped to your firm's zone.
2. Paste the token plus your Account ID and Zone ID; click **Validate**.
3. Pick the staff and (optional) portal subdomains; click **Provision**.

The app creates the tunnel, writes DNS CNAMEs, fetches the run-token,
encrypts it with the firm key, and drops it into the shared volume the
sidecar watches. cloudflared connects automatically — no shell access
or `cloudflared tunnel run` required.

Subsequent hostname changes apply through the same UI without
restarting the sidecar (Cloudflare manages ingress server-side). The
portal hostname is always recorded but only added as an ingress rule
when a commercial portal license is active on the appliance.

The legacy `ops/cloudflared/config.example.yml` is preserved for
operators who prefer a self-managed (CLI) setup, but the in-app flow
is the supported path.

## 7. Verify health

```bash
curl https://app.firm.com/health
curl https://app.firm.com/health/ready
```

Both should return 200. `/health/ready` includes a `wiring` block
showing which optional integrations are configured.

## 8. Schedule backups

The appliance writes nightly `pg_dump` files to `/backups`. The
recommended pattern is a host-side rclone/syncthing job that mirrors
`/backups` to off-host storage every 6 hours. See
`ops/docs/restore.md` for the restore procedure.

## 9. Hardening

- Set up the host firewall to allow only Cloudflare egress (or your
  Tailscale tunnel) — see `ops/docs/network-topology.md`.
- Rotate JWT signing keys annually (re-deploy with new env values; all
  sessions log out cleanly).
- Configure the AI monthly budget cap in admin → Firm settings
  (default $100/mo per Q14).

## Troubleshooting

- **Migrations fail with "lockfile out of date"** — pull the matching
  release image; do not run migrations from a different version's
  Drizzle snapshot.
- **Portal returns 503** — set `COMMERCIAL_LICENSE_TOKEN` in `.env`
  and restart. License absence intentionally disables the portal.
- **AI features return 503** — wire either `ANTHROPIC_API_KEY` or a
  local Ollama. Both can coexist; local is preferred per Q15.
- **Workers idle** — check Redis connectivity. Worker container logs
  show BullMQ `connection` errors if Redis isn't reachable.

For ongoing operations see `ops/docs/upgrade-path.md` and
`ops/docs/network-topology.md`.
