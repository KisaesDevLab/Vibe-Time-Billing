#!/usr/bin/env bash
# SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
#
# Tear down the appliance cleanly.
#
# Two modes:
#   ./uninstall.sh           Stop the stack. Keep data + .env so a later
#                            `./install.sh` resumes without losing
#                            invoices / clients / time entries.
#   ./uninstall.sh --purge   Stop the stack AND delete every volume
#                            (postgres data, redis data, backups,
#                            caddy data, static-content, cloudflared
#                            credentials). Irreversible — there's a
#                            confirmation prompt.

set -euo pipefail

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RST=$'\033[0m'
  RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'
else
  BOLD=''; RST=''; RED=''; GRN=''; YEL=''
fi
ok()   { printf "%s✓%s %s\n" "$GRN" "$RST" "$*"; }
warn() { printf "%s!%s %s\n" "$YEL" "$RST" "$*"; }
fail() { printf "%s✗%s %s\n" "$RED" "$RST" "$*"; exit 1; }
step() { printf "\n%s%s%s\n" "$BOLD" "$*" "$RST"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="ops/docker/docker-compose.prod.yml"
DC=(docker compose -f "$COMPOSE_FILE")

PURGE=false
for arg in "$@"; do
  case "$arg" in
    --purge|-p) PURGE=true ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--purge]

  (no args)   Stop containers. Volumes + .env are preserved so install.sh
              can resume the same firm + data.
  --purge     Stop AND delete every appliance volume (postgres, redis,
              backups, caddy data, cloudflared creds, static content).
              You'll be prompted to confirm.
EOF
      exit 0
      ;;
    *) fail "Unknown argument: $arg (use --help)" ;;
  esac
done

if ! docker info >/dev/null 2>&1; then
  fail "Docker isn't running. Start it and try again."
fi

step "Stopping the appliance"
"${DC[@]}" down --remove-orphans
ok "Containers stopped"

if $PURGE; then
  printf "\n%s%s%s\n" "$RED" "WARNING:" "$RST"
  printf "  --purge will delete %sALL%s appliance data:\n" "$BOLD" "$RST"
  printf "    • PostgreSQL data (every client, engagement, invoice, time entry)\n"
  printf "    • Redis data (sessions, OTP nonces)\n"
  printf "    • Backups in /backups\n"
  printf "    • Caddy TLS certs\n"
  printf "    • Cloudflare Tunnel credentials\n"
  printf "    • Cached static content\n"
  printf "  This is %sirreversible%s.\n\n" "$BOLD" "$RST"
  read -rp "Type 'delete everything' to confirm: " CONFIRM
  if [ "$CONFIRM" != "delete everything" ]; then
    warn "Purge cancelled. Volumes preserved."
    exit 0
  fi
  "${DC[@]}" down --volumes --remove-orphans
  ok "All volumes deleted"
  if [ -f .env ]; then
    BACKUP=".env.purged-$(date +%Y%m%d-%H%M%S)"
    mv .env "$BACKUP"
    warn ".env moved to $BACKUP (kept on disk in case you need the secrets)"
  fi
fi

cat <<EOF

${GRN}${BOLD}Uninstall complete.${RST}

Re-install when ready:
  ${BOLD}./ops/scripts/install.sh${RST}

EOF
