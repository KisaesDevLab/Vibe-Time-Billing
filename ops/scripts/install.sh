#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
#
# Vibe Practice Management — one-command appliance installer for CPAs.
#
# What it does:
#   1. Verifies Docker + Docker Compose v2 + openssl are installed.
#   2. Logs in to ghcr.io if the image can't be pulled anonymously.
#   3. Asks for FOUR things only: firm name, admin email + name, the
#      hostname or URL where staff will reach the app.
#   4. Generates secure secrets (STAFF_JWT_SECRET, PORTAL_JWT_SECRET,
#      POSTGRES_PASSWORD) — never typed by hand.
#   5. Writes .env, pulls the image, brings up the stack, runs all
#      database migrations, and seeds the firm + admin user.
#   6. Prints the next-step URL.
#
# Re-runnable: safe to invoke again on the same VM. Existing .env is
# backed up before overwrite; the bootstrap script is idempotent on
# firm name; migrations skip already-applied steps.
#
# Tested on Ubuntu 22.04, Debian 12, macOS 14, and Windows WSL2.

set -euo pipefail

# ---------------------------------------------------------------------
# Pretty output
# ---------------------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RST=$'\033[0m'
  RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[34m'
else
  BOLD=''; RST=''; RED=''; GRN=''; YEL=''; BLU=''
fi
say()  { printf "%s\n" "$*"; }
ok()   { printf "%s✓%s %s\n" "$GRN" "$RST" "$*"; }
warn() { printf "%s!%s %s\n" "$YEL" "$RST" "$*"; }
fail() { printf "%s✗%s %s\n" "$RED" "$RST" "$*"; exit 1; }
step() { printf "\n%s%s%s\n" "$BOLD" "$*" "$RST"; }

cleanup_msg() {
  printf "\n%sInstall stopped.%s See above for the error.\n" "$YEL" "$RST"
  printf "Logs (if the stack came up):\n"
  printf "  %sdocker compose -f ops/docker/docker-compose.prod.yml logs%s\n" "$BOLD" "$RST"
  printf "Re-run when ready:\n"
  printf "  %s./ops/scripts/install.sh%s\n" "$BOLD" "$RST"
}
trap cleanup_msg ERR

# ---------------------------------------------------------------------
# Resolve repo root (script lives at ops/scripts/install.sh)
# ---------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="ops/docker/docker-compose.prod.yml"
DC=(docker compose -f "$COMPOSE_FILE")

# ---------------------------------------------------------------------
# Step 1: prerequisites
# ---------------------------------------------------------------------
step "[1/8] Checking your machine"

command -v docker >/dev/null 2>&1 \
  || fail "Docker isn't installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ (Windows / macOS) or follow https://docs.docker.com/engine/install/ (Linux), then run this script again."

docker compose version >/dev/null 2>&1 \
  || fail "Docker Compose v2 is missing. Update Docker Desktop, or on Linux install the compose plugin: https://docs.docker.com/compose/install/linux/"

command -v openssl >/dev/null 2>&1 \
  || fail "openssl is required (used to generate sign-in keys). Install it via your package manager (e.g. 'sudo apt install openssl' on Debian/Ubuntu)."

docker info >/dev/null 2>&1 \
  || fail "Docker is installed but not running. Start Docker Desktop (or 'sudo systemctl start docker' on Linux) and try again."

ok "Docker + Docker Compose + openssl are ready"

# ---------------------------------------------------------------------
# Step 2: GHCR authentication
# ---------------------------------------------------------------------
step "[2/8] Connecting to GitHub Container Registry"

IMAGE="ghcr.io/kisaesdevlab/vibe-time-billing:${TAG:-v0.1.0}"

# Probe: can we pull the image manifest without credentials?
if docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
  ok "Image is publicly available — no login required"
else
  say ""
  say "The appliance image is in a private package. You need a GitHub"
  say "Personal Access Token (PAT) with the 'read:packages' permission."
  say ""
  say "How to create one (takes 30 seconds):"
  say "  1. Open https://github.com/settings/tokens/new in your browser"
  say "  2. Note: 'Vibe TB install'  (or anything you'll recognize)"
  say "  3. Expiration: choose 90 days or longer"
  say "  4. Check the box next to:  read:packages"
  say "  5. Click 'Generate token' at the bottom"
  say "  6. Copy the token (starts with ghp_…) — paste it below"
  say ""
  read -rp "GitHub username: " GH_USER
  read -rsp "Personal Access Token (paste, will be hidden): " GH_TOKEN
  echo ""
  if [ -z "$GH_USER" ] || [ -z "$GH_TOKEN" ]; then
    fail "Username and token are both required."
  fi
  echo "$GH_TOKEN" | docker login ghcr.io --username "$GH_USER" --password-stdin >/dev/null \
    || fail "GitHub login failed. Double-check the token has 'read:packages' scope."
  ok "Logged in to ghcr.io as $GH_USER"
fi

# ---------------------------------------------------------------------
# Step 3: firm details (the only thing the user has to type)
# ---------------------------------------------------------------------
step "[3/8] Tell us about your firm"

if [ -t 0 ]; then
  read -rp "Firm name (e.g. 'Smith & Co CPAs'): " FIRM_NAME
  while [ -z "${FIRM_NAME// /}" ]; do
    read -rp "  Firm name can't be empty — try again: " FIRM_NAME
  done

  read -rp "Admin email (you'll receive sign-in links here): " ADMIN_EMAIL
  while ! [[ "$ADMIN_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; do
    read -rp "  That doesn't look like a valid email — try again: " ADMIN_EMAIL
  done

  read -rp "Admin display name [Firm Administrator]: " ADMIN_NAME
  ADMIN_NAME="${ADMIN_NAME:-Firm Administrator}"

  # Detect a reasonable default URL. On Linux 'hostname -I' yields the
  # LAN IP. On macOS we fall back to localhost — the user usually wants
  # to set their domain anyway.
  DEFAULT_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [ -z "$DEFAULT_IP" ]; then DEFAULT_IP="localhost"; fi
  DEFAULT_URL="http://$DEFAULT_IP"
  say ""
  say "Where will staff access this appliance?"
  say "  - For local-network use right now, accept the default."
  say "  - If you already have a domain pointed here, paste the full URL"
  say "    (e.g. https://app.smithco-cpa.com)."
  say "  - You can change this later via the Cloudflare Tunnel admin UI."
  read -rp "App URL [$DEFAULT_URL]: " APP_URL
  APP_URL="${APP_URL:-$DEFAULT_URL}"
else
  # Non-interactive (e.g. piped CI). Require the values via env vars.
  : "${FIRM_NAME:?set FIRM_NAME (non-interactive mode)}"
  : "${ADMIN_EMAIL:?set ADMIN_EMAIL (non-interactive mode)}"
  ADMIN_NAME="${ADMIN_NAME:-Firm Administrator}"
  APP_URL="${APP_URL:-http://localhost}"
fi

# Derive WEBAUTHN_RP_ID from the URL (host part, no scheme, no port).
RP_HOST="$(printf '%s' "$APP_URL" | sed -E 's|^https?://||; s|/.*$||; s|:[0-9]+$||')"
if [ -z "$RP_HOST" ]; then RP_HOST="localhost"; fi

ok "Firm:   $FIRM_NAME"
ok "Admin:  $ADMIN_NAME <$ADMIN_EMAIL>"
ok "URL:    $APP_URL"

# ---------------------------------------------------------------------
# Step 4: secrets + .env
# ---------------------------------------------------------------------
step "[4/8] Generating sign-in keys and writing .env"

if [ -f .env ]; then
  BACKUP=".env.backup-$(date +%Y%m%d-%H%M%S)"
  cp .env "$BACKUP"
  warn "Existing .env saved as $BACKUP"
fi

rand_hex() { openssl rand -hex "$1"; }

STAFF_JWT_SECRET="$(rand_hex 32)"
PORTAL_JWT_SECRET="$(rand_hex 32)"
POSTGRES_PASSWORD="$(rand_hex 24)"

cat > .env <<EOF
# Generated by ops/scripts/install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Do not commit. Re-running install.sh will back up + overwrite this file.

# === Application ===
NODE_ENV=production
LOG_LEVEL=info
APP_BASE_URL=$APP_URL
PORTAL_BASE_URL=$APP_URL
TAG=${TAG:-v0.1.0}

# === Database / Redis (bundled in the compose) ===
POSTGRES_USER=vibe
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=vibe_tb
DATABASE_URL=postgresql://vibe:$POSTGRES_PASSWORD@postgres:5432/vibe_tb
REDIS_URL=redis://redis:6379

# === Session signing keys (generated; rotate via env if compromised) ===
STAFF_JWT_SECRET=$STAFF_JWT_SECRET
PORTAL_JWT_SECRET=$PORTAL_JWT_SECRET

# === WebAuthn / passkeys ===
# rp_id = the bare domain (no scheme, no port). Derived from APP_URL.
WEBAUTHN_RP_ID=$RP_HOST
WEBAUTHN_RP_NAME=$FIRM_NAME
WEBAUTHN_ORIGIN=$APP_URL

# === Mail / SMS / commercial license (configure later via admin UI) ===
MAIL_PROVIDER=smtp
SMS_PROVIDER=console
COMMERCIAL_LICENSE_TOKEN=

# === Backup retention ===
BACKUP_RETENTION_DAYS=30
EOF
ok "Wrote .env (secrets generated)"

# ---------------------------------------------------------------------
# Step 5: pull image
# ---------------------------------------------------------------------
step "[5/8] Pulling the appliance image (multi-arch — first run takes a few minutes)"

"${DC[@]}" --env-file .env pull
ok "Image pulled"

# ---------------------------------------------------------------------
# Step 6: start the stack
# ---------------------------------------------------------------------
step "[6/8] Starting the appliance (postgres, redis, api, worker, web, portal, caddy)"

"${DC[@]}" --env-file .env up -d
ok "Containers started"

# ---------------------------------------------------------------------
# Step 7: wait for api health
# ---------------------------------------------------------------------
step "[7/8] Waiting for the API to come online (up to 2 minutes)"

API_HEALTHY=false
for i in $(seq 1 60); do
  state="$(docker inspect --format '{{.State.Health.Status}}' vibe-tb-api 2>/dev/null || echo unknown)"
  if [ "$state" = "healthy" ]; then
    API_HEALTHY=true
    break
  fi
  printf "."
  sleep 2
done
echo ""
if ! $API_HEALTHY; then
  fail "API didn't reach 'healthy' within 2 minutes. Check 'docker compose -f $COMPOSE_FILE logs api'."
fi
ok "API is healthy"

# ---------------------------------------------------------------------
# Step 8: migrate + bootstrap firm
# ---------------------------------------------------------------------
step "[8/8] Setting up your firm"

# Migrations are idempotent — applied once, skipped thereafter.
"${DC[@]}" --env-file .env exec -T \
  -e DATABASE_URL="postgresql://vibe:$POSTGRES_PASSWORD@postgres:5432/vibe_tb" \
  api node packages/db/dist/scripts/migrate.js
ok "Database migrations applied"

# Bootstrap firm + admin user. Idempotent on firm name — re-running on
# an existing firm is a no-op (the script exits cleanly with a message).
"${DC[@]}" --env-file .env exec -T \
  -e DATABASE_URL="postgresql://vibe:$POSTGRES_PASSWORD@postgres:5432/vibe_tb" \
  -e FIRM_NAME="$FIRM_NAME" \
  -e ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e ADMIN_NAME="$ADMIN_NAME" \
  api node packages/db/dist/scripts/bootstrap-firm.js
ok "Firm and admin user created"

# Clear the trap — we're done.
trap - ERR

# ---------------------------------------------------------------------
# Done!
# ---------------------------------------------------------------------
cat <<EOF

${GRN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}
${GRN}${BOLD}  Install complete — ${FIRM_NAME} is ready${RST}
${GRN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}

${BOLD}1.${RST} Open your browser to:
   ${BOLD}${APP_URL}/auth/login${RST}

${BOLD}2.${RST} Enter your admin email:
   ${BOLD}${ADMIN_EMAIL}${RST}
   and click "Send sign-in link".

${BOLD}3.${RST} If you haven't configured an email provider yet, the magic
   link won't actually be emailed. Read it from the API log instead:
   ${BOLD}docker compose -f ${COMPOSE_FILE} logs api 2>&1 | grep magic-link${RST}

${BOLD}4.${RST} Set up a second factor when prompted (passkey, authenticator
   app, email code, or SMS — pick whichever is easiest).

${BOLD}5.${RST} Once signed in, head to:
   ${BLU}Admin → Operations → Cloudflare Tunnel${RST}
       to make the app reachable on a real domain.
   ${BLU}Admin → Messaging${RST}
       to configure your email provider so sign-in links arrive.

${BOLD}Common commands:${RST}
  Stop:    ${BOLD}docker compose -f ${COMPOSE_FILE} down${RST}
  Logs:    ${BOLD}docker compose -f ${COMPOSE_FILE} logs -f${RST}
  Upgrade: ${BOLD}git pull && ./ops/scripts/install.sh${RST}
  Uninstall: ${BOLD}./ops/scripts/uninstall.sh${RST}

EOF
