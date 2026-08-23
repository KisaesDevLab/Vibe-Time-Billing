# Install runbook

Self-hosted Vibe Practice Management appliance from "fresh VM" to "live
firm" in about 15 minutes. There is no SaaS layer (Q1).

## Quick install (recommended)

For most CPA firms, the easiest path is the one-command installer.
It handles every step below for you — prereq checks, generating
sign-in keys, writing `.env`, pulling the image, starting the stack,
running database migrations, and bootstrapping your firm + admin user.

```bash
git clone https://github.com/KisaesDevLab/Vibe-Time-Billing.git
cd Vibe-Time-Billing
./ops/scripts/install.sh
```

The installer will ask you for four things:

1. **Firm name** — e.g. `Smith & Co CPAs`
2. **Admin email** — where the first sign-in link is sent
3. **Admin display name** — defaults to `Firm Administrator`
4. **App URL** — the URL staff will use; defaults to your VM's IP
   address. You can change this later via the Cloudflare Tunnel
   admin UI without re-running the installer.

When it finishes, open the printed URL, enter your admin email, and
follow the email link. Pick a second factor (passkey is easiest if
your laptop supports Touch ID / Windows Hello).

To remove the appliance: `./ops/scripts/uninstall.sh` (preserves data
for re-install) or `./ops/scripts/uninstall.sh --purge` (wipes
everything — prompts for confirmation).

## Prerequisites

- 4 vCPU / 8 GB RAM minimum (16 GB recommended if you'll run the
  local LLM). Ubuntu 22.04 LTS, Debian 12, macOS 14, and Windows WSL2
  are tested.
- Docker Engine 24+ and `docker compose` v2.
- `openssl` (for key generation; pre-installed on every supported OS).
- A GitHub Personal Access Token with `read:packages` scope —
  https://github.com/settings/tokens/new — the installer prompts for
  this if the image isn't publicly available yet.
- (Optional, configure later) An SMTP / Postmark / Resend / SES
  account so sign-in links actually arrive in inboxes. Without one,
  the link is in the API container logs.

## Manual install (advanced)

If you'd rather do each step yourself, here's what the installer does
under the hood:

### 1. Pull the appliance image

```bash
docker login ghcr.io -u <your-gh-username>   # paste the PAT when prompted
docker pull ghcr.io/kisaesdevlab/vibe-time-billing:v0.1.0
```

### 2. Create the environment file

```bash
cp .env.example .env
```

Required values to set (everything else has sensible defaults):

- `APP_BASE_URL` + `PORTAL_BASE_URL` — the URLs staff and clients use.
- `STAFF_JWT_SECRET` and `PORTAL_JWT_SECRET` — generate with
  `openssl rand -hex 32`. **Distinct keys** per CLAUDE.md #10.
- `POSTGRES_PASSWORD` — `openssl rand -hex 24`.
- `WEBAUTHN_RP_ID` — the bare domain (no scheme, no port), e.g.
  `app.firm.com`.

Optional but recommended:
- `STRIPE_SECRET_KEY` (Q7 — firm-owned account)
- `ANTHROPIC_API_KEY` or local Ollama config (Q15)

### 3. Bring up the stack

```bash
docker compose -f ops/docker/docker-compose.prod.yml --env-file .env up -d
```

This starts: Postgres, Redis, API, worker, Caddy ingress (with the
bundled staff + portal SPAs), the `cloudflared` sidecar (waiting for
its run-token), and the nightly backup cron.

### 4. Run migrations + bootstrap the firm

```bash
docker compose -f ops/docker/docker-compose.prod.yml exec api \
  node packages/db/dist/scripts/migrate.js

docker compose -f ops/docker/docker-compose.prod.yml exec \
  -e FIRM_NAME="Smith & Co CPAs" \
  -e ADMIN_EMAIL="you@firm.com" \
  -e ADMIN_NAME="Firm Administrator" \
  api node packages/db/dist/scripts/bootstrap-firm.js
```

`bootstrap-firm` creates the firm row, an admin user with the email
you provide, the `admin` role + role assignment, four service lines
(Tax / Audit / Advisory / Bookkeeping), the StandardRate rate code,
and the default notification templates + retainer tier configs. It's
idempotent on firm name.

### 5. First-time login

1. Navigate to `<APP_URL>/auth/login`.
2. Enter your admin email. A magic-link email is sent (or appears in
   the API log if mail isn't configured yet:
   `docker compose -f ops/docker/docker-compose.prod.yml logs api 2>&1 | grep magic-link`).
3. Click the link.
4. Enroll a second factor when prompted (passkey, TOTP, email OTP,
   or SMS — pick what's easiest).
5. Land on the dashboard. Visit Admin → Operations → Cloudflare
   Tunnel to put the appliance behind your domain.

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
- **Portal returns 503 `portal_disabled`** — the firm has turned the portal
  off (Admin → Firm settings → Client portal). Re-enable it there.
- **AI features return 503** — wire either `ANTHROPIC_API_KEY` or a
  local Ollama. Both can coexist; local is preferred per Q15.
- **Workers idle** — check Redis connectivity. Worker container logs
  show BullMQ `connection` errors if Redis isn't reachable.

For ongoing operations see `ops/docs/upgrade-path.md` and
`ops/docs/network-topology.md`.
