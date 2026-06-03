#!/usr/bin/env bash
# =============================================================================
# backup.sh — Nightly database backup for Vibe Practice Management
#
# Per QUESTIONS.md Q12: pg_dump nightly cron, 30-day retention, mounted volume.
#
# Schedule via cron in the appliance image:
#   0 2 * * * /app/ops/scripts/backup.sh
#
# Output: /backups/vibe-tb-YYYY-MM-DD.sql.gz
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP="$(date +%Y-%m-%d)"
BACKUP_FILE="${BACKUP_DIR}/vibe-tb-${TIMESTAMP}.sql.gz"
LOG_FILE="${BACKUP_DIR}/backup.log"

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
log() {
  local msg="[$(date -Iseconds)] $*"
  echo "${msg}"
  echo "${msg}" >> "${LOG_FILE}"
}

abort() {
  log "ERROR: $*"
  # If backup failed, alert via webhook if configured
  if [[ -n "${BACKUP_FAILURE_WEBHOOK:-}" ]]; then
    curl -fsS -X POST "${BACKUP_FAILURE_WEBHOOK}" \
      -H "Content-Type: application/json" \
      -d "{\"event\":\"backup_failed\",\"timestamp\":\"$(date -Iseconds)\",\"error\":\"$*\"}" \
      || true
  fi
  exit 1
}

# -----------------------------------------------------------------------------
# Pre-flight
# -----------------------------------------------------------------------------
mkdir -p "${BACKUP_DIR}"

if [[ -f "${BACKUP_FILE}" ]]; then
  log "Backup for ${TIMESTAMP} already exists at ${BACKUP_FILE} — overwriting"
fi

# Verify postgres is reachable
if ! pg_isready -d "${DATABASE_URL}" >/dev/null 2>&1; then
  abort "Postgres not reachable at DATABASE_URL"
fi

# -----------------------------------------------------------------------------
# Run backup
# -----------------------------------------------------------------------------
log "Starting backup → ${BACKUP_FILE}"

pg_dump "${DATABASE_URL}" \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  --quote-all-identifiers \
  2>>"${LOG_FILE}" | gzip --best > "${BACKUP_FILE}" \
  || abort "pg_dump failed (see ${LOG_FILE})"

# Verify the file is non-trivial
size_bytes=$(stat -c%s "${BACKUP_FILE}" 2>/dev/null || stat -f%z "${BACKUP_FILE}" 2>/dev/null || echo 0)
if (( size_bytes < 1024 )); then
  abort "Backup file too small (${size_bytes} bytes) — likely failed"
fi

log "Backup complete — ${BACKUP_FILE} (${size_bytes} bytes)"

# -----------------------------------------------------------------------------
# Prune old backups
# -----------------------------------------------------------------------------
log "Pruning backups older than ${RETENTION_DAYS} days..."

pruned_count=$(find "${BACKUP_DIR}" -name 'vibe-tb-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
log "Pruned ${pruned_count} old backup(s)"

# -----------------------------------------------------------------------------
# Verify backup is restorable (lightweight)
# -----------------------------------------------------------------------------
# Check that gunzip can decompress the head of the file (quick integrity check;
# full restore-verification runs monthly per ops/docs/restore.md).
if ! gunzip -t "${BACKUP_FILE}" 2>/dev/null; then
  abort "Backup file failed gzip integrity check"
fi

log "Backup verified — gzip integrity OK"

# -----------------------------------------------------------------------------
# Success webhook (optional)
# -----------------------------------------------------------------------------
if [[ -n "${BACKUP_SUCCESS_WEBHOOK:-}" ]]; then
  curl -fsS -X POST "${BACKUP_SUCCESS_WEBHOOK}" \
    -H "Content-Type: application/json" \
    -d "{\"event\":\"backup_succeeded\",\"timestamp\":\"$(date -Iseconds)\",\"file\":\"${BACKUP_FILE}\",\"size_bytes\":${size_bytes}}" \
    || log "Warning: success webhook failed (non-fatal)"
fi

log "Backup job complete"
exit 0
